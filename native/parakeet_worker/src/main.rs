use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use hound::{SampleFormat, WavReader};
use parakeet_rs::{ExecutionConfig, ParakeetTDT, TimedToken, TimestampMode, Transcriber};
use serde::Deserialize;
use serde_json::json;
use std::io::{self, Read, Write};
use std::path::Path;
use std::time::Instant;

const INPUT_SAMPLE_RATE: u32 = 16_000;
const MAX_JSON_BYTES: usize = 8 * 1024 * 1024;
const MAX_AUDIO_BYTES: usize = 128 * 1024 * 1024;

const DEFAULT_STREAM_MIN_AUDIO_MS: u32 = 120;
const DEFAULT_STREAM_DECODE_INTERVAL_MS: u32 = 160;
const DEFAULT_STREAM_MAX_WINDOW_MS: u32 = 6_000;
const DEFAULT_STREAM_LEFT_CONTEXT_MS: u32 = 1_000;
const DEFAULT_STREAM_STABILITY_HOLD_MS: u32 = 220;
const STREAM_TIMESTAMP_TOLERANCE_MS: u32 = 120;

#[derive(Debug)]
struct Config {
    model_path: String,
    threads: i32,
    serve: bool,
    healthcheck: bool,
    stream_min_audio_ms: u32,
    stream_decode_interval_ms: u32,
    stream_max_window_ms: u32,
    stream_left_context_ms: u32,
    stream_stability_hold_ms: u32,
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

struct TdtStreamState {
    sample_rate: u32,
    audio: Vec<f32>,
    audio_start_sample: usize,
    pending_samples: usize,
    committed_text: String,
    committed_until_sample: usize,
}

impl TdtStreamState {
    fn new(sample_rate: u32) -> Self {
        Self {
            sample_rate,
            audio: Vec::new(),
            audio_start_sample: 0,
            pending_samples: 0,
            committed_text: String::new(),
            committed_until_sample: 0,
        }
    }
}

struct NativeParakeetEngine {
    tdt: ParakeetTDT,
    stream: Option<TdtStreamState>,
    min_stream_samples: usize,
    decode_interval_samples: usize,
    max_decode_window_samples: usize,
    stream_left_context_samples: usize,
    stream_stability_hold_samples: usize,
    stream_timestamp_tolerance_samples: usize,
    stream_trim_keep_samples: usize,
}

impl NativeParakeetEngine {
    fn new(cfg: &Config) -> Result<Self, String> {
        let exec_config = ExecutionConfig::new()
            .with_intra_threads(cfg.threads.max(1) as usize)
            .with_inter_threads(1);

        let tdt = ParakeetTDT::from_pretrained(&cfg.model_path, Some(exec_config))
            .map_err(|err| format!("failed to load native Parakeet TDT model: {err}"))?;

        let min_stream_samples = ((cfg.stream_min_audio_ms as u64 * INPUT_SAMPLE_RATE as u64) / 1000) as usize;
        let decode_interval_samples =
            ((cfg.stream_decode_interval_ms as u64 * INPUT_SAMPLE_RATE as u64) / 1000) as usize;
        let max_decode_window_samples =
            ((cfg.stream_max_window_ms as u64 * INPUT_SAMPLE_RATE as u64) / 1000) as usize;
        let stream_left_context_samples =
            ((cfg.stream_left_context_ms as u64 * INPUT_SAMPLE_RATE as u64) / 1000) as usize;
        let stream_stability_hold_samples =
            ((cfg.stream_stability_hold_ms as u64 * INPUT_SAMPLE_RATE as u64) / 1000) as usize;
        let stream_timestamp_tolerance_samples =
            ((STREAM_TIMESTAMP_TOLERANCE_MS as u64 * INPUT_SAMPLE_RATE as u64) / 1000) as usize;

        let max_decode_window_samples = max_decode_window_samples.max(min_stream_samples).max(1);
        let stream_left_context_samples = stream_left_context_samples
            .min(max_decode_window_samples.saturating_sub(1))
            .max(1);
        let stream_stability_hold_samples = stream_stability_hold_samples
            .min(max_decode_window_samples.saturating_sub(1))
            .max(1);
        let stream_trim_keep_samples = stream_left_context_samples
            .saturating_add((INPUT_SAMPLE_RATE as usize * 3) / 2)
            .max(stream_left_context_samples + 1);

        Ok(Self {
            tdt,
            stream: None,
            min_stream_samples: min_stream_samples.max(1),
            decode_interval_samples: decode_interval_samples.max(1),
            max_decode_window_samples,
            stream_left_context_samples,
            stream_stability_hold_samples,
            stream_timestamp_tolerance_samples: stream_timestamp_tolerance_samples.max(1),
            stream_trim_keep_samples,
        })
    }

    fn warmup(&mut self) -> Result<(), String> {
        // Tiny warmup decode to pre-initialize ONNX kernels.
        let warmup_samples = vec![0.0_f32; 1024];
        let _ = self
            .tdt
            .transcribe_samples(warmup_samples, INPUT_SAMPLE_RATE, 1, Some(TimestampMode::Words))
            .map_err(|err| format!("native Parakeet warmup failed: {err}"))?;
        Ok(())
    }

    fn transcribe(&mut self, audio: Vec<f32>, sample_rate: u32) -> Result<(String, f64), String> {
        let (result, duration_seconds) = self.transcribe_with_timestamps(audio, sample_rate)?;
        Ok((normalize_text(&result.text), duration_seconds))
    }

    fn transcribe_with_timestamps(
        &mut self,
        audio: Vec<f32>,
        sample_rate: u32,
    ) -> Result<(parakeet_rs::TranscriptionResult, f64), String> {
        if sample_rate != INPUT_SAMPLE_RATE {
            return Err(format!(
                "sampleRate mismatch: expected {INPUT_SAMPLE_RATE}, got {sample_rate}"
            ));
        }

        let started = Instant::now();
        let result = self
            .tdt
            .transcribe_samples(audio, sample_rate, 1, Some(TimestampMode::Words))
            .map_err(|err| format!("native Parakeet transcribe failed: {err}"))?;

        Ok((result, started.elapsed().as_secs_f64()))
    }

    fn stream_reset(&mut self, sample_rate: u32) -> Result<(), String> {
        if sample_rate != INPUT_SAMPLE_RATE {
            return Err(format!(
                "sampleRate mismatch: expected {INPUT_SAMPLE_RATE}, got {sample_rate}"
            ));
        }

        self.stream = Some(TdtStreamState::new(sample_rate));
        Ok(())
    }

    fn stream_push(&mut self, audio_chunk: Vec<f32>, sample_rate: u32) -> Result<(String, f64), String> {
        if sample_rate != INPUT_SAMPLE_RATE {
            return Err(format!(
                "sampleRate mismatch: expected {INPUT_SAMPLE_RATE}, got {sample_rate}"
            ));
        }

        if self.stream.is_none() {
            self.stream_reset(sample_rate)?;
        }

        let (decode_audio, decode_sample_rate, decode_window_start_sample, committed_until_sample) = {
            let state = self
                .stream
                .as_mut()
                .ok_or_else(|| "stream state unavailable".to_string())?;

            state.audio.extend_from_slice(&audio_chunk);
            state.pending_samples += audio_chunk.len();

            if state.audio.len() < self.min_stream_samples
                || state.pending_samples < self.decode_interval_samples
            {
                return Ok((String::new(), 0.0));
            }

            state.pending_samples = 0;
            let stream_end_sample = state.audio_start_sample + state.audio.len();
            let min_window_start = stream_end_sample.saturating_sub(self.max_decode_window_samples);
            let context_window_start = state
                .committed_until_sample
                .saturating_sub(self.stream_left_context_samples);
            let decode_window_start_sample = context_window_start
                .max(min_window_start)
                .max(state.audio_start_sample);
            let decode_window_local_start = decode_window_start_sample - state.audio_start_sample;

            (
                state.audio[decode_window_local_start..].to_vec(),
                state.sample_rate,
                decode_window_start_sample,
                state.committed_until_sample,
            )
        };

        let decode_window_samples = decode_audio.len().max(1);
        let (result, duration_seconds) =
            self.transcribe_with_timestamps(decode_audio, decode_sample_rate)?;

        let stable_cutoff_sample = decode_window_start_sample.saturating_add(
            decode_window_samples.saturating_sub(self.stream_stability_hold_samples),
        );

        let (delta_text, delta_end_sample) = collect_new_stable_text(
            &result.tokens,
            decode_window_start_sample,
            committed_until_sample,
            stable_cutoff_sample,
            decode_sample_rate,
            self.stream_timestamp_tolerance_samples,
        );

        let state = self
            .stream
            .as_mut()
            .ok_or_else(|| "stream state unavailable".to_string())?;

        if !delta_text.is_empty() {
            append_committed_delta(&mut state.committed_text, &delta_text);
            if delta_end_sample > state.committed_until_sample {
                state.committed_until_sample = delta_end_sample;
            }
        }

        trim_stream_buffer(state, self.stream_trim_keep_samples);

        Ok((normalize_text(&delta_text), duration_seconds))
    }

    fn stream_flush(&mut self) -> Result<(String, f64), String> {
        let (decode_audio, decode_sample_rate, decode_window_start_sample, committed_until_sample) = {
            let Some(state) = self.stream.as_mut() else {
                return Ok((String::new(), 0.0));
            };

            if state.audio.is_empty() {
                return Ok((String::new(), 0.0));
            }

            (
                state.audio.clone(),
                state.sample_rate,
                state.audio_start_sample,
                state.committed_until_sample,
            )
        };

        let decode_window_samples = decode_audio.len();
        let (result, duration_seconds) =
            self.transcribe_with_timestamps(decode_audio, decode_sample_rate)?;
        let flush_cutoff_sample =
            decode_window_start_sample.saturating_add(decode_window_samples);
        let (delta_text, delta_end_sample) = collect_new_stable_text(
            &result.tokens,
            decode_window_start_sample,
            committed_until_sample,
            flush_cutoff_sample,
            decode_sample_rate,
            self.stream_timestamp_tolerance_samples,
        );

        let Some(state) = self.stream.as_mut() else {
            return Ok((String::new(), duration_seconds));
        };

        if !delta_text.is_empty() {
            append_committed_delta(&mut state.committed_text, &delta_text);
            if delta_end_sample > state.committed_until_sample {
                state.committed_until_sample = delta_end_sample;
            }
        }

        Ok((normalize_text(&delta_text), duration_seconds))
    }

    fn stream_close(&mut self) {
        self.stream = None;
    }
}

fn parse_args() -> Result<Config, String> {
    let args: Vec<String> = std::env::args().collect();

    let mut model_path: Option<String> = None;
    let mut threads = 4_i32;
    let mut serve = false;
    let mut healthcheck = false;
    let mut stream_min_audio_ms = DEFAULT_STREAM_MIN_AUDIO_MS;
    let mut stream_decode_interval_ms = DEFAULT_STREAM_DECODE_INTERVAL_MS;
    let mut stream_max_window_ms = DEFAULT_STREAM_MAX_WINDOW_MS;
    let mut stream_left_context_ms = DEFAULT_STREAM_LEFT_CONTEXT_MS;
    let mut stream_stability_hold_ms = DEFAULT_STREAM_STABILITY_HOLD_MS;

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
            "--stream-min-audio-ms" => {
                if i + 1 >= args.len() {
                    return Err("Missing value for --stream-min-audio-ms".into());
                }
                stream_min_audio_ms = args[i + 1]
                    .parse::<u32>()
                    .map_err(|_| "Invalid --stream-min-audio-ms value".to_string())?;
                i += 2;
            }
            "--stream-decode-interval-ms" => {
                if i + 1 >= args.len() {
                    return Err("Missing value for --stream-decode-interval-ms".into());
                }
                stream_decode_interval_ms = args[i + 1]
                    .parse::<u32>()
                    .map_err(|_| "Invalid --stream-decode-interval-ms value".to_string())?;
                i += 2;
            }
            "--stream-max-window-ms" => {
                if i + 1 >= args.len() {
                    return Err("Missing value for --stream-max-window-ms".into());
                }
                stream_max_window_ms = args[i + 1]
                    .parse::<u32>()
                    .map_err(|_| "Invalid --stream-max-window-ms value".to_string())?;
                i += 2;
            }
            "--stream-left-context-ms" => {
                if i + 1 >= args.len() {
                    return Err("Missing value for --stream-left-context-ms".into());
                }
                stream_left_context_ms = args[i + 1]
                    .parse::<u32>()
                    .map_err(|_| "Invalid --stream-left-context-ms value".to_string())?;
                i += 2;
            }
            "--stream-stability-hold-ms" => {
                if i + 1 >= args.len() {
                    return Err("Missing value for --stream-stability-hold-ms".into());
                }
                stream_stability_hold_ms = args[i + 1]
                    .parse::<u32>()
                    .map_err(|_| "Invalid --stream-stability-hold-ms value".to_string())?;
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
                    "usage: dingoflow-parakeet-worker --model /path/to/parakeet-tdt-onnx-dir [--threads 4] [--stream-min-audio-ms 120] [--stream-decode-interval-ms 160] [--stream-max-window-ms 6000] [--stream-left-context-ms 1000] [--stream-stability-hold-ms 220] --serve"
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

        if !(40..=1000).contains(&stream_min_audio_ms) {
            return Err("--stream-min-audio-ms must be between 40 and 1000".into());
        }

        if !(40..=1500).contains(&stream_decode_interval_ms) {
            return Err("--stream-decode-interval-ms must be between 40 and 1500".into());
        }

        if !(800..=30000).contains(&stream_max_window_ms) {
            return Err("--stream-max-window-ms must be between 800 and 30000".into());
        }

        if !(200..=5000).contains(&stream_left_context_ms) {
            return Err("--stream-left-context-ms must be between 200 and 5000".into());
        }

        if !(80..=1200).contains(&stream_stability_hold_ms) {
            return Err("--stream-stability-hold-ms must be between 80 and 1200".into());
        }

        if stream_left_context_ms >= stream_max_window_ms {
            return Err("--stream-left-context-ms must be less than --stream-max-window-ms".into());
        }

        if stream_stability_hold_ms >= stream_max_window_ms {
            return Err("--stream-stability-hold-ms must be less than --stream-max-window-ms".into());
        }
    }

    Ok(Config {
        model_path,
        threads,
        serve,
        healthcheck,
        stream_min_audio_ms,
        stream_decode_interval_ms,
        stream_max_window_ms,
        stream_left_context_ms,
        stream_stability_hold_ms,
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

    if spec.channels <= 1 {
        return Ok((samples, spec.sample_rate));
    }

    let channels = spec.channels as usize;
    let mut mono = Vec::with_capacity(samples.len() / channels);
    for chunk in samples.chunks(channels) {
        let avg = chunk.iter().sum::<f32>() / channels as f32;
        mono.push(avg);
    }

    Ok((mono, spec.sample_rate))
}

fn decode_audio(req: &Request, framed_audio: &[u8]) -> Result<(Vec<f32>, u32), String> {
    if !framed_audio.is_empty() {
        let sample_rate = req.sample_rate.unwrap_or(INPUT_SAMPLE_RATE);
        return Ok((pcm16_to_f32(framed_audio), sample_rate));
    }

    if let Some(base64_audio) = &req.audio_base64 {
        let raw = BASE64_STANDARD
            .decode(base64_audio)
            .map_err(|err| format!("invalid audioBase64: {err}"))?;
        let sample_rate = req.sample_rate.unwrap_or(INPUT_SAMPLE_RATE);
        return Ok((pcm16_to_f32(&raw), sample_rate));
    }

    if let Some(path) = &req.audio {
        return wav_to_f32(path);
    }

    Err("Missing binary audio payload, audioBase64, or audio path".into())
}

fn make_asr_result(text: String, duration_seconds: f64) -> serde_json::Value {
    json!({
        "text": text,
        "language": "en",
        "durationSeconds": ((duration_seconds * 1000.0).round() / 1000.0)
    })
}

fn run_server(mut engine: NativeParakeetEngine) -> Result<(), String> {
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
                    "warmup" => match engine.warmup() {
                        Ok(_) => json!({
                            "id": request_id,
                            "ok": true,
                            "result": { "ready": true }
                        }),
                        Err(error) => json!({
                            "id": request_id,
                            "ok": false,
                            "error": error
                        }),
                    },
                    "stream_reset" => {
                        let sample_rate = req.sample_rate.unwrap_or(INPUT_SAMPLE_RATE);
                        match engine.stream_reset(sample_rate) {
                            Ok(_) => json!({
                                "id": request_id,
                                "ok": true,
                                "result": { "ready": true }
                            }),
                            Err(error) => json!({
                                "id": request_id,
                                "ok": false,
                                "error": error
                            }),
                        }
                    }
                    "stream_push" => match decode_audio(&req, &audio_bytes)
                        .and_then(|(audio, sample_rate)| engine.stream_push(audio, sample_rate))
                    {
                        Ok((text, duration_seconds)) => json!({
                            "id": request_id,
                            "ok": true,
                            "result": make_asr_result(text, duration_seconds)
                        }),
                        Err(error) => json!({
                            "id": request_id,
                            "ok": false,
                            "error": error
                        }),
                    },
                    "stream_flush" => match engine.stream_flush() {
                        Ok((text, duration_seconds)) => json!({
                            "id": request_id,
                            "ok": true,
                            "result": make_asr_result(text, duration_seconds)
                        }),
                        Err(error) => json!({
                            "id": request_id,
                            "ok": false,
                            "error": error
                        }),
                    },
                    "stream_close" => {
                        engine.stream_close();
                        json!({
                            "id": request_id,
                            "ok": true,
                            "result": { "closed": true }
                        })
                    }
                    "transcribe" => match decode_audio(&req, &audio_bytes)
                        .and_then(|(audio, sample_rate)| engine.transcribe(audio, sample_rate))
                    {
                        Ok((text, duration_seconds)) => json!({
                            "id": request_id,
                            "ok": true,
                            "result": make_asr_result(text, duration_seconds)
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

fn push_text_piece(out: &mut String, piece: &str, wrote_any: &mut bool) {
    let is_standalone_punct = piece.len() == 1
        && piece
            .chars()
            .all(|ch| matches!(ch, '.' | ',' | '!' | '?' | ';' | ':' | ')'));
    if *wrote_any && !is_standalone_punct {
        out.push(' ');
    }
    out.push_str(piece);
    *wrote_any = true;
}

fn seconds_to_samples(sample_rate: u32, seconds: f32) -> usize {
    if !seconds.is_finite() || seconds <= 0.0 {
        return 0;
    }

    (seconds * sample_rate as f32).round() as usize
}

fn collect_new_stable_text(
    tokens: &[TimedToken],
    decode_window_start_sample: usize,
    committed_until_sample: usize,
    stable_cutoff_sample: usize,
    sample_rate: u32,
    timestamp_tolerance_samples: usize,
) -> (String, usize) {
    let mut out = String::new();
    let mut wrote_any = false;
    let mut newest_sample = committed_until_sample;

    let effective_tolerance_samples = if committed_until_sample == 0 {
        0
    } else {
        timestamp_tolerance_samples
    };

    for token in tokens {
        let token_end_sample =
            decode_window_start_sample.saturating_add(seconds_to_samples(sample_rate, token.end));

        if token_end_sample > stable_cutoff_sample {
            break;
        }

        if token_end_sample <= committed_until_sample.saturating_add(effective_tolerance_samples) {
            continue;
        }

        let piece = token.text.trim();
        if piece.is_empty() {
            continue;
        }

        push_text_piece(&mut out, piece, &mut wrote_any);
        newest_sample = token_end_sample;
    }

    (normalize_text(&out), newest_sample)
}

fn append_committed_delta(committed_text: &mut String, delta: &str) {
    if delta.is_empty() {
        return;
    }

    if committed_text.is_empty() {
        committed_text.push_str(delta);
        return;
    }

    let needs_space = !committed_text.ends_with([' ', '\n'])
        && !delta.starts_with(['.', ',', '!', '?', ';', ':', ')']);
    if needs_space {
        committed_text.push(' ');
    }
    committed_text.push_str(delta);
}

fn trim_stream_buffer(state: &mut TdtStreamState, keep_samples: usize) {
    let trim_until_sample = state.committed_until_sample.saturating_sub(keep_samples);
    if trim_until_sample <= state.audio_start_sample {
        return;
    }

    let trim_samples = trim_until_sample - state.audio_start_sample;
    if trim_samples == 0 {
        return;
    }

    if trim_samples >= state.audio.len() {
        state.audio.clear();
        state.audio_start_sample = trim_until_sample;
        return;
    }

    state.audio.drain(0..trim_samples);
    state.audio_start_sample = trim_until_sample;
}

fn normalize_text(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ").trim().to_string()
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
        eprintln!("Parakeet model path not found: {}", cfg.model_path);
        std::process::exit(1);
    }

    if !model_path.is_dir() {
        eprintln!("Native Parakeet backend expects DINGOFLOW_ASR_MODEL_PATH to be a model directory.");
        std::process::exit(1);
    }

    let encoder = model_path.join("encoder-model.onnx");
    let encoder_alt = model_path.join("encoder.onnx");
    let decoder_joint = model_path.join("decoder_joint-model.onnx");
    let decoder_joint_alt = model_path.join("decoder_joint.onnx");
    let vocab = model_path.join("vocab.txt");
    if (!encoder.exists() && !encoder_alt.exists())
        || (!decoder_joint.exists() && !decoder_joint_alt.exists())
        || !vocab.exists()
    {
        eprintln!(
            "Parakeet native model directory must contain encoder-model.onnx (or encoder.onnx), decoder_joint-model.onnx (or decoder_joint.onnx), and vocab.txt: {}",
            cfg.model_path
        );
        std::process::exit(1);
    }

    if !cfg.serve {
        eprintln!("--serve is required");
        std::process::exit(1);
    }

    let engine = match NativeParakeetEngine::new(&cfg) {
        Ok(value) => value,
        Err(err) => {
            eprintln!("{err}");
            std::process::exit(1);
        }
    };

    if let Err(err) = run_server(engine) {
        eprintln!("{err}");
        std::process::exit(1);
    }
}
