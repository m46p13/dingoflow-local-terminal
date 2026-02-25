use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use hound::{SampleFormat, WavReader};
use serde::Deserialize;
use serde_json::json;
use std::io::{self, Read, Write};
use std::path::Path;
use std::time::Instant;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

const INPUT_SAMPLE_RATE: u32 = 16_000;
const MAX_JSON_BYTES: usize = 8 * 1024 * 1024;
const MAX_AUDIO_BYTES: usize = 128 * 1024 * 1024;

#[derive(Debug)]
struct Config {
    model_path: String,
    threads: i32,
    serve: bool,
    healthcheck: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    id: Option<String>,
    action: Option<String>,
    audio: Option<String>,
    audio_base64: Option<String>,
    sample_rate: Option<u32>,
}

fn parse_args() -> Result<Config, String> {
    let args: Vec<String> = std::env::args().collect();

    let mut model_path: Option<String> = None;
    let mut threads = 4_i32;
    let mut serve = false;
    let mut healthcheck = false;

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--model" => {
                if i + 1 >= args.len() {
                    return Err("Missing value for --model".into());
                }
                model_path = Some(args[i + 1].clone());
                i += 2;
            }
            "--threads" => {
                if i + 1 >= args.len() {
                    return Err("Missing value for --threads".into());
                }
                threads = args[i + 1]
                    .parse::<i32>()
                    .map_err(|_| "Invalid --threads value".to_string())?;
                i += 2;
            }
            "--serve" => {
                serve = true;
                i += 1;
            }
            "--healthcheck" => {
                healthcheck = true;
                i += 1;
            }
            "--help" | "-h" => {
                return Err(
                    "usage: dingoflow-asr-worker --model /path/to/ggml-model.bin [--threads 4] --serve"
                        .into(),
                );
            }
            other => {
                return Err(format!("Unsupported argument: {other}"));
            }
        }
    }

    let model_path = model_path.unwrap_or_default();

    if !healthcheck {
        if model_path.is_empty() {
            return Err("--model is required unless --healthcheck is used".into());
        }

        if !(1..=64).contains(&threads) {
            return Err("--threads must be between 1 and 64".into());
        }
    }

    Ok(Config {
        model_path,
        threads,
        serve,
        healthcheck,
    })
}

fn read_exact_allow_eof<R: Read>(reader: &mut R, size: usize) -> io::Result<Option<Vec<u8>>> {
    let mut buf = vec![0_u8; size];
    let mut offset = 0_usize;

    while offset < size {
        let read = reader.read(&mut buf[offset..])?;
        if read == 0 {
            if offset == 0 {
                return Ok(None);
            }
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "incomplete frame",
            ));
        }
        offset += read;
    }

    Ok(Some(buf))
}

fn read_exact_required<R: Read>(reader: &mut R, size: usize) -> io::Result<Vec<u8>> {
    let mut buf = vec![0_u8; size];
    let mut offset = 0_usize;
    while offset < size {
        let read = reader.read(&mut buf[offset..])?;
        if read == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "incomplete frame body",
            ));
        }
        offset += read;
    }
    Ok(buf)
}

fn write_response<W: Write>(writer: &mut W, response: serde_json::Value) -> io::Result<()> {
    let body = serde_json::to_vec(&response)
        .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err.to_string()))?;

    let len = body.len() as u32;
    writer.write_all(&len.to_le_bytes())?;
    writer.write_all(&body)?;
    writer.flush()
}

fn pcm16_to_f32(audio: &[u8]) -> Vec<f32> {
    let mut out = Vec::with_capacity(audio.len() / 2);
    for pair in audio.chunks_exact(2) {
        let sample = i16::from_le_bytes([pair[0], pair[1]]);
        out.push(sample as f32 / i16::MAX as f32);
    }
    out
}

fn wav_to_f32(path: &str) -> Result<(Vec<f32>, u32), String> {
    let mut reader =
        WavReader::open(path).map_err(|err| format!("failed to open wav audio file: {err}"))?;
    let spec = reader.spec();
    if spec.channels != 1 {
        return Err("wav input must be mono".into());
    }

    let samples = match spec.sample_format {
        SampleFormat::Int => {
            if spec.bits_per_sample != 16 {
                return Err("wav int input must be 16-bit".into());
            }

            reader
                .samples::<i16>()
                .map(|sample| sample.map(|v| v as f32 / i16::MAX as f32))
                .collect::<Result<Vec<f32>, _>>()
                .map_err(|err| format!("failed to read wav samples: {err}"))?
        }
        SampleFormat::Float => reader
            .samples::<f32>()
            .collect::<Result<Vec<f32>, _>>()
            .map_err(|err| format!("failed to read wav samples: {err}"))?,
    };

    Ok((samples, spec.sample_rate))
}

fn normalize_whisper_text(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ").trim().to_string()
}

fn transcribe_with_whisper(
    context: &WhisperContext,
    pcm_f32: &[f32],
    sample_rate: u32,
    threads: i32,
) -> Result<serde_json::Value, String> {
    if sample_rate != INPUT_SAMPLE_RATE {
        return Err(format!(
            "sampleRate mismatch: expected {INPUT_SAMPLE_RATE}, got {sample_rate}"
        ));
    }

    let started = Instant::now();
    let mut state = context
        .create_state()
        .map_err(|err| format!("failed to create whisper state: {err}"))?;

    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_n_threads(threads);
    params.set_no_context(true);
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_language(Some("en"));
    params.set_translate(false);

    state
        .full(params, pcm_f32)
        .map_err(|err| format!("whisper decode failed: {err}"))?;

    let segments = state.full_n_segments();

    let mut text = String::new();
    for i in 0..segments {
        let segment = state
            .get_segment(i)
            .ok_or_else(|| format!("failed to read segment {i}"))?;
        let segment_text = segment
            .to_str()
            .map_err(|err| format!("failed to read segment text: {err}"))?;
        text.push_str(segment_text);
    }

    let duration_seconds = started.elapsed().as_secs_f64();

    Ok(json!({
        "text": normalize_whisper_text(&text),
        "language": "en",
        "durationSeconds": ((duration_seconds * 1000.0).round() / 1000.0)
    }))
}

fn transcribe_request(
    context: &WhisperContext,
    req: &Request,
    framed_audio: &[u8],
    threads: i32,
) -> Result<serde_json::Value, String> {
    if !framed_audio.is_empty() {
        let sample_rate = req.sample_rate.unwrap_or(INPUT_SAMPLE_RATE);
        let pcm = pcm16_to_f32(framed_audio);
        return transcribe_with_whisper(context, &pcm, sample_rate, threads);
    }

    if let Some(base64_audio) = &req.audio_base64 {
        let raw = BASE64_STANDARD
            .decode(base64_audio)
            .map_err(|err| format!("invalid audioBase64: {err}"))?;
        let sample_rate = req.sample_rate.unwrap_or(INPUT_SAMPLE_RATE);
        let pcm = pcm16_to_f32(&raw);
        return transcribe_with_whisper(context, &pcm, sample_rate, threads);
    }

    if let Some(path) = &req.audio {
        let (pcm, sample_rate) = wav_to_f32(path)?;
        return transcribe_with_whisper(context, &pcm, sample_rate, threads);
    }

    Err("Missing binary audio payload, audioBase64, or audio path".into())
}

fn run_server(context: WhisperContext, threads: i32) -> Result<(), String> {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut reader = stdin.lock();
    let mut writer = stdout.lock();

    loop {
        let header = match read_exact_allow_eof(&mut reader, 8) {
            Ok(Some(value)) => value,
            Ok(None) => break,
            Err(err) => return Err(format!("failed to read frame header: {err}")),
        };

        let json_len = u32::from_le_bytes([header[0], header[1], header[2], header[3]]) as usize;
        let audio_len = u32::from_le_bytes([header[4], header[5], header[6], header[7]]) as usize;

        if json_len == 0 || json_len > MAX_JSON_BYTES {
            return Err(format!("invalid json frame size: {json_len}"));
        }

        if audio_len > MAX_AUDIO_BYTES {
            return Err(format!("audio frame too large: {audio_len}"));
        }

        let request_id_fallback = "unknown".to_string();

        let json_bytes =
            read_exact_required(&mut reader, json_len).map_err(|err| format!("frame json read failed: {err}"))?;
        let audio_bytes = if audio_len > 0 {
            read_exact_required(&mut reader, audio_len)
                .map_err(|err| format!("frame audio read failed: {err}"))?
        } else {
            Vec::new()
        };

        let req_parse = serde_json::from_slice::<Request>(&json_bytes)
            .map_err(|err| format!("invalid JSON request: {err}"));

        let response = match req_parse {
            Ok(req) => {
                let action = req.action.as_deref().unwrap_or("transcribe");
                let request_id = req.id.clone().unwrap_or_else(|| request_id_fallback.clone());

                match action {
                    "warmup" => json!({
                        "id": request_id,
                        "ok": true,
                        "result": { "ready": true }
                    }),
                    "transcribe" => match transcribe_request(&context, &req, &audio_bytes, threads) {
                        Ok(result) => json!({
                            "id": request_id,
                            "ok": true,
                            "result": result
                        }),
                        Err(error) => json!({
                            "id": request_id,
                            "ok": false,
                            "error": error
                        }),
                    },
                    other => json!({
                        "id": request_id,
                        "ok": false,
                        "error": format!("Unsupported action: {other}")
                    }),
                }
            }
            Err(error) => json!({
                "id": request_id_fallback,
                "ok": false,
                "error": error
            }),
        };

        write_response(&mut writer, response)
            .map_err(|err| format!("failed to write response: {err}"))?;
    }

    Ok(())
}

fn run_once(context: &WhisperContext, cfg: &Config) -> Result<(), String> {
    let stdin = io::stdin();
    let mut reader = stdin.lock();
    let mut input = Vec::new();
    reader
        .read_to_end(&mut input)
        .map_err(|err| format!("failed to read stdin audio: {err}"))?;

    let result = transcribe_with_whisper(context, &pcm16_to_f32(&input), INPUT_SAMPLE_RATE, cfg.threads)?;
    println!(
        "{}",
        serde_json::to_string(&result).map_err(|err| format!("json serialize failed: {err}"))?
    );
    Ok(())
}

fn main() {
    let cfg = match parse_args() {
        Ok(value) => value,
        Err(err) => {
            eprintln!("{err}");
            std::process::exit(1);
        }
    };

    if cfg.healthcheck {
        println!("ok");
        return;
    }

    let model_path = Path::new(&cfg.model_path);
    if !model_path.exists() {
        eprintln!("ASR model path not found: {}", cfg.model_path);
        std::process::exit(1);
    }

    if !model_path.is_file() {
        eprintln!(
            "Native whisper backend expects DINGOFLOW_ASR_MODEL_PATH to be a ggml model file (.bin)."
        );
        std::process::exit(1);
    }

    let params = WhisperContextParameters::default();
    let context = match WhisperContext::new_with_params(&cfg.model_path, params) {
        Ok(ctx) => ctx,
        Err(err) => {
            eprintln!("Failed to load whisper model: {err}");
            std::process::exit(1);
        }
    };

    let result = if cfg.serve {
        run_server(context, cfg.threads)
    } else {
        run_once(&context, &cfg)
    };

    if let Err(err) = result {
        eprintln!("{err}");
        std::process::exit(1);
    }
}
