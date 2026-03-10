use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{BufferSize, SampleFormat, SampleRate, StreamConfig};
use std::collections::VecDeque;
use std::env;
use std::io::{self, BufWriter, Write};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use webrtc_vad::{SampleRate as VadSampleRate, Vad, VadMode};

struct Config {
    target_sample_rate: u32,
    vad_mode: VadMode,
    vad_frame_ms: usize,
    onset_ms: usize,
    hangover_ms: usize,
    preroll_ms: usize,
}

struct LinearResampler {
    ratio: f64,
    position: f64,
    carry: Vec<f32>,
    passthrough: bool,
}

impl LinearResampler {
    fn new(input_rate: u32, target_rate: u32) -> Self {
        let passthrough = input_rate == target_rate;
        Self {
            ratio: input_rate as f64 / target_rate as f64,
            position: 0.0,
            carry: Vec::with_capacity(8192),
            passthrough,
        }
    }

    fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
        if input.is_empty() {
            return;
        }

        if self.passthrough {
            out.extend_from_slice(input);
            return;
        }

        self.carry.extend_from_slice(input);
        let carry_len = self.carry.len() as f64;

        while self.position + 1.0 < carry_len {
            let index = self.position.floor() as usize;
            let frac = (self.position - index as f64) as f32;
            let a = self.carry[index];
            let b = self.carry[index + 1];
            out.push(a + (b - a) * frac);
            self.position += self.ratio;
        }

        let drop_count = self.position.floor() as usize;
        if drop_count > 0 && drop_count <= self.carry.len() {
            let remaining = self.carry.len() - drop_count;
            self.carry.copy_within(drop_count.., 0);
            self.carry.truncate(remaining);
            self.position -= drop_count as f64;
        }
    }
}

struct DcBlocker {
    prev_input: f32,
    prev_output: f32,
}

impl DcBlocker {
    fn new() -> Self {
        Self {
            prev_input: 0.0,
            prev_output: 0.0,
        }
    }

    fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
        out.reserve(input.len());
        for &sample in input {
            let filtered = sample - self.prev_input + 0.995 * self.prev_output;
            self.prev_input = sample;
            self.prev_output = filtered;
            out.push(filtered);
        }
    }
}

struct NativeVadGate {
    vad: Vad,
    frame_samples: usize,
    onset_frames: usize,
    hangover_frames: usize,
    preroll_frames: usize,
    pending: Vec<i16>,
    preroll: VecDeque<Vec<i16>>,
    active: bool,
    consecutive_speech: usize,
    consecutive_silence: usize,
    noise_floor_dbfs: f32,
}

// The VAD handle is only accessed behind the recorder's callback-thread mutex.
unsafe impl Send for NativeVadGate {}

impl NativeVadGate {
    fn new(sample_rate: u32, config: &Config) -> Result<Self, String> {
        let vad_sample_rate = match sample_rate {
            8_000 => VadSampleRate::Rate8kHz,
            16_000 => VadSampleRate::Rate16kHz,
            32_000 => VadSampleRate::Rate32kHz,
            48_000 => VadSampleRate::Rate48kHz,
            _ => return Err("native VAD requires 8k/16k/32k/48k sample rate".into()),
        };

        if !matches!(config.vad_frame_ms, 10 | 20 | 30) {
            return Err("native VAD frame size must be 10, 20, or 30 ms".into());
        }

        let frame_samples = ((sample_rate as usize) * config.vad_frame_ms) / 1000;
        if frame_samples == 0 {
            return Err("native VAD frame size produced zero samples".into());
        }

        let onset_frames = ms_to_frames(config.onset_ms, config.vad_frame_ms).max(1);
        let hangover_frames = ms_to_frames(config.hangover_ms, config.vad_frame_ms).max(1);
        let preroll_frames = ms_to_frames(config.preroll_ms, config.vad_frame_ms);

        Ok(Self {
            vad: Vad::new_with_rate_and_mode(vad_sample_rate, copy_vad_mode(&config.vad_mode)),
            frame_samples,
            onset_frames,
            hangover_frames,
            preroll_frames,
            pending: Vec::with_capacity(frame_samples * 4),
            preroll: VecDeque::with_capacity(preroll_frames.saturating_add(2)),
            active: false,
            consecutive_speech: 0,
            consecutive_silence: 0,
            noise_floor_dbfs: -90.0,
        })
    }

    fn process_block(&mut self, block: &[i16], output: &mut Vec<i16>) {
        if block.is_empty() {
            return;
        }

        self.pending.extend_from_slice(block);

        while self.pending.len() >= self.frame_samples {
            let frame = self.pending[..self.frame_samples].to_vec();
            self.pending.drain(0..self.frame_samples);
            self.process_frame(frame, output);
        }
    }

    fn process_frame(&mut self, mut frame: Vec<i16>, output: &mut Vec<i16>) {
        let rms_dbfs = frame_rms_dbfs(&frame);
        let voiced = self.vad.is_voice_segment(&frame).unwrap_or(false);

        if !voiced {
            self.update_noise_floor(rms_dbfs);
        }

        apply_noise_suppression(&mut frame, rms_dbfs, self.noise_floor_dbfs);

        if !self.active {
            self.push_preroll(frame.clone());
            if voiced {
                self.consecutive_speech += 1;
            } else {
                self.consecutive_speech = 0;
            }

            if self.consecutive_speech >= self.onset_frames {
                self.active = true;
                self.consecutive_silence = 0;
                while let Some(preroll_frame) = self.preroll.pop_front() {
                    output.extend_from_slice(&preroll_frame);
                }
                self.preroll.clear();
            }
            return;
        }

        output.extend_from_slice(&frame);
        if voiced {
            self.consecutive_silence = 0;
        } else {
            self.consecutive_silence += 1;
        }

        if self.consecutive_silence >= self.hangover_frames {
            self.active = false;
            self.consecutive_speech = 0;
            self.consecutive_silence = 0;
            self.preroll.clear();
            self.push_preroll(frame);
        }
    }

    fn push_preroll(&mut self, frame: Vec<i16>) {
        if self.preroll_frames == 0 {
            return;
        }

        self.preroll.push_back(frame);
        while self.preroll.len() > self.preroll_frames {
            self.preroll.pop_front();
        }
    }

    fn update_noise_floor(&mut self, rms_dbfs: f32) {
        if !rms_dbfs.is_finite() {
            return;
        }

        if self.noise_floor_dbfs <= -89.0 {
            self.noise_floor_dbfs = rms_dbfs;
            return;
        }

        self.noise_floor_dbfs = self.noise_floor_dbfs * 0.96 + rms_dbfs * 0.04;
    }
}

fn parse_config() -> Result<Config, String> {
    let mut target_sample_rate = 16_000_u32;
    let mut vad_mode = VadMode::VeryAggressive;
    let mut vad_frame_ms = 20_usize;
    let mut onset_ms = 120_usize;
    let mut hangover_ms = 360_usize;
    let mut preroll_ms = 180_usize;
    let args: Vec<String> = env::args().collect();
    let mut i = 1;

    while i < args.len() {
        match args[i].as_str() {
            "--sample-rate" => {
                if i + 1 >= args.len() {
                    return Err("Missing value for --sample-rate".into());
                }
                target_sample_rate = args[i + 1]
                    .parse::<u32>()
                    .map_err(|_| "Invalid --sample-rate value".to_string())?;
                i += 2;
            }
            "--vad-mode" => {
                if i + 1 >= args.len() {
                    return Err("Missing value for --vad-mode".into());
                }
                vad_mode = match args[i + 1].as_str() {
                    "quality" => VadMode::Quality,
                    "low-bitrate" => VadMode::LowBitrate,
                    "aggressive" => VadMode::Aggressive,
                    "very-aggressive" => VadMode::VeryAggressive,
                    _ => return Err("Invalid --vad-mode value".into()),
                };
                i += 2;
            }
            "--vad-frame-ms" => {
                if i + 1 >= args.len() {
                    return Err("Missing value for --vad-frame-ms".into());
                }
                vad_frame_ms = args[i + 1]
                    .parse::<usize>()
                    .map_err(|_| "Invalid --vad-frame-ms value".to_string())?;
                i += 2;
            }
            "--speech-onset-ms" => {
                if i + 1 >= args.len() {
                    return Err("Missing value for --speech-onset-ms".into());
                }
                onset_ms = args[i + 1]
                    .parse::<usize>()
                    .map_err(|_| "Invalid --speech-onset-ms value".to_string())?;
                i += 2;
            }
            "--speech-hangover-ms" => {
                if i + 1 >= args.len() {
                    return Err("Missing value for --speech-hangover-ms".into());
                }
                hangover_ms = args[i + 1]
                    .parse::<usize>()
                    .map_err(|_| "Invalid --speech-hangover-ms value".to_string())?;
                i += 2;
            }
            "--speech-preroll-ms" => {
                if i + 1 >= args.len() {
                    return Err("Missing value for --speech-preroll-ms".into());
                }
                preroll_ms = args[i + 1]
                    .parse::<usize>()
                    .map_err(|_| "Invalid --speech-preroll-ms value".to_string())?;
                i += 2;
            }
            "--help" | "-h" => {
                return Err(
                    "usage: dingoflow-audio-loop [--sample-rate 16000] [--vad-mode very-aggressive] [--vad-frame-ms 20] [--speech-onset-ms 120] [--speech-hangover-ms 360] [--speech-preroll-ms 180]"
                        .into(),
                );
            }
            other => {
                return Err(format!("Unsupported argument: {other}"));
            }
        }
    }

    if !(8_000..=96_000).contains(&target_sample_rate) {
        return Err("sample rate must be between 8000 and 96000".into());
    }
    if !matches!(vad_frame_ms, 10 | 20 | 30) {
        return Err("vad frame size must be 10, 20, or 30 milliseconds".into());
    }

    Ok(Config {
        target_sample_rate,
        vad_mode,
        vad_frame_ms,
        onset_ms,
        hangover_ms,
        preroll_ms,
    })
}

fn ms_to_frames(total_ms: usize, frame_ms: usize) -> usize {
    if total_ms == 0 || frame_ms == 0 {
        return 0;
    }
    total_ms.div_ceil(frame_ms)
}

fn copy_vad_mode(mode: &VadMode) -> VadMode {
    match mode {
        VadMode::Quality => VadMode::Quality,
        VadMode::LowBitrate => VadMode::LowBitrate,
        VadMode::Aggressive => VadMode::Aggressive,
        VadMode::VeryAggressive => VadMode::VeryAggressive,
    }
}

fn vad_mode_name(mode: &VadMode) -> &'static str {
    match mode {
        VadMode::Quality => "quality",
        VadMode::LowBitrate => "low-bitrate",
        VadMode::Aggressive => "aggressive",
        VadMode::VeryAggressive => "very-aggressive",
    }
}

fn to_mono_f32<T, F>(input: &[T], channels: usize, to_f32: F, out: &mut Vec<f32>)
where
    F: Fn(T) -> f32,
    T: Copy,
{
    if channels <= 1 {
        out.extend(input.iter().copied().map(to_f32));
        return;
    }

    for frame in input.chunks(channels) {
        if frame.is_empty() {
            continue;
        }

        let sum = frame.iter().copied().map(&to_f32).sum::<f32>();
        out.push(sum / channels as f32);
    }
}

fn f32_to_i16(input: &[f32], out: &mut Vec<i16>) {
    out.reserve(input.len());
    for sample in input {
        let clamped = sample.clamp(-1.0, 1.0);
        out.push((clamped * i16::MAX as f32) as i16);
    }
}

fn frame_rms_dbfs(frame: &[i16]) -> f32 {
    if frame.is_empty() {
        return -90.0;
    }

    let mut sum_squares = 0.0_f64;
    for &sample in frame {
        let normalized = sample as f64 / i16::MAX as f64;
        sum_squares += normalized * normalized;
    }

    let rms = (sum_squares / frame.len() as f64).sqrt() as f32;
    if rms <= 0.0 {
        -90.0
    } else {
        20.0 * rms.log10()
    }
}

fn apply_noise_suppression(frame: &mut [i16], rms_dbfs: f32, noise_floor_dbfs: f32) {
    if frame.is_empty() || !rms_dbfs.is_finite() || !noise_floor_dbfs.is_finite() {
        return;
    }

    let snr_db = rms_dbfs - noise_floor_dbfs;
    let gain = if snr_db >= 18.0 {
        1.0
    } else if snr_db <= 0.0 {
        0.28
    } else {
        0.28 + (snr_db / 18.0) * 0.72
    };

    for sample in frame.iter_mut() {
        let adjusted = (*sample as f32 * gain).round();
        *sample = adjusted.clamp(i16::MIN as f32, i16::MAX as f32) as i16;
    }
}

fn run() -> Result<(), String> {
    let config = parse_config()?;
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or("default input device not available")?;

    let default_cfg = device
        .default_input_config()
        .map_err(|e| format!("failed to query default input config: {e}"))?;

    let input_sample_rate = default_cfg.sample_rate().0;
    let channels = default_cfg.channels() as usize;
    let target_buffer_frames = (input_sample_rate / 200).clamp(64, 1024);
    let stream_config = StreamConfig {
        channels: default_cfg.channels(),
        sample_rate: SampleRate(input_sample_rate),
        buffer_size: BufferSize::Fixed(target_buffer_frames),
    };

    let resampler = Arc::new(Mutex::new(LinearResampler::new(
        input_sample_rate,
        config.target_sample_rate,
    )));
    let dc_blocker = Arc::new(Mutex::new(DcBlocker::new()));
    let vad_gate = Arc::new(Mutex::new(NativeVadGate::new(
        config.target_sample_rate,
        &config,
    )?));

    let (tx, rx) = mpsc::channel::<Vec<i16>>();
    let _writer_thread = thread::spawn(move || {
        let stdout = io::stdout();
        let mut writer = BufWriter::with_capacity(64 * 1024, stdout.lock());
        let mut bytes = Vec::<u8>::with_capacity(64 * 1024);

        while let Ok(block) = rx.recv() {
            if block.is_empty() {
                continue;
            }

            bytes.clear();
            bytes.reserve(block.len() * 2);
            for sample in block {
                bytes.extend_from_slice(&sample.to_le_bytes());
            }

            if writer.write_all(&bytes).is_err() {
                break;
            }

            if writer.flush().is_err() {
                break;
            }
        }
    });

    let error_callback = |error| {
        eprintln!("stream-error: {error}");
    };

    let stream = match default_cfg.sample_format() {
        SampleFormat::F32 => {
            let tx = tx.clone();
            let resampler = Arc::clone(&resampler);
            let dc_blocker = Arc::clone(&dc_blocker);
            let vad_gate = Arc::clone(&vad_gate);
            device
                .build_input_stream(
                    &stream_config,
                    move |data: &[f32], _| {
                        process_input_block(
                            data,
                            channels,
                            |v| v,
                            &resampler,
                            &dc_blocker,
                            &vad_gate,
                            &tx,
                        );
                    },
                    error_callback,
                    None,
                )
                .map_err(|e| format!("failed to build input stream: {e}"))?
        }
        SampleFormat::I16 => {
            let tx = tx.clone();
            let resampler = Arc::clone(&resampler);
            let dc_blocker = Arc::clone(&dc_blocker);
            let vad_gate = Arc::clone(&vad_gate);
            device
                .build_input_stream(
                    &stream_config,
                    move |data: &[i16], _| {
                        process_input_block(
                            data,
                            channels,
                            |v| v as f32 / i16::MAX as f32,
                            &resampler,
                            &dc_blocker,
                            &vad_gate,
                            &tx,
                        );
                    },
                    error_callback,
                    None,
                )
                .map_err(|e| format!("failed to build input stream: {e}"))?
        }
        SampleFormat::U16 => {
            let tx = tx.clone();
            let resampler = Arc::clone(&resampler);
            let dc_blocker = Arc::clone(&dc_blocker);
            let vad_gate = Arc::clone(&vad_gate);
            device
                .build_input_stream(
                    &stream_config,
                    move |data: &[u16], _| {
                        process_input_block(
                            data,
                            channels,
                            |v| (v as f32 / u16::MAX as f32) * 2.0 - 1.0,
                            &resampler,
                            &dc_blocker,
                            &vad_gate,
                            &tx,
                        );
                    },
                    error_callback,
                    None,
                )
                .map_err(|e| format!("failed to build input stream: {e}"))?
        }
        unsupported => {
            return Err(format!("unsupported sample format: {unsupported:?}"));
        }
    };

    stream
        .play()
        .map_err(|e| format!("failed to start input stream: {e}"))?;

    eprintln!(
        "READY input_sample_rate={} target_sample_rate={} channels={} vad_mode={} vad_frame_ms={}",
        input_sample_rate,
        config.target_sample_rate,
        channels,
        vad_mode_name(&config.vad_mode),
        config.vad_frame_ms
    );

    loop {
        thread::sleep(Duration::from_secs(60));
    }
}

fn process_input_block<T, F>(
    data: &[T],
    channels: usize,
    to_f32: F,
    resampler: &Arc<Mutex<LinearResampler>>,
    dc_blocker: &Arc<Mutex<DcBlocker>>,
    vad_gate: &Arc<Mutex<NativeVadGate>>,
    tx: &mpsc::Sender<Vec<i16>>,
) where
    F: Fn(T) -> f32,
    T: Copy,
{
    let mut mono = Vec::<f32>::with_capacity(data.len() / channels.max(1));
    let mut filtered = Vec::<f32>::with_capacity(mono.capacity());
    let mut out = Vec::<f32>::with_capacity(mono.capacity());
    let mut pcm = Vec::<i16>::with_capacity(mono.capacity());
    let mut gated = Vec::<i16>::with_capacity(mono.capacity());

    to_mono_f32(data, channels, to_f32, &mut mono);
    if let Ok(mut blocker) = dc_blocker.lock() {
        blocker.process(&mono, &mut filtered);
    } else {
        filtered.extend_from_slice(&mono);
    }
    if let Ok(mut rs) = resampler.lock() {
        rs.process(&filtered, &mut out);
    }
    if out.is_empty() {
        return;
    }
    f32_to_i16(&out, &mut pcm);
    if let Ok(mut gate) = vad_gate.lock() {
        gate.process_block(&pcm, &mut gated);
    }
    if gated.is_empty() {
        return;
    }
    let _ = tx.send(gated);
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
