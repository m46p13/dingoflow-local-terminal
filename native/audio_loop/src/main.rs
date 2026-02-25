use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{BufferSize, SampleFormat, SampleRate, StreamConfig};
use std::env;
use std::io::{self, BufWriter, Write};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

#[derive(Debug)]
struct Config {
    target_sample_rate: u32,
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

fn parse_config() -> Result<Config, String> {
    let mut target_sample_rate = 16_000_u32;
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
            "--help" | "-h" => {
                return Err("usage: dingoflow-audio-loop [--sample-rate 16000]".into());
            }
            other => {
                return Err(format!("Unsupported argument: {other}"));
            }
        }
    }

    if !(8_000..=96_000).contains(&target_sample_rate) {
        return Err("sample rate must be between 8000 and 96000".into());
    }

    Ok(Config { target_sample_rate })
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

    let (tx, rx) = mpsc::channel::<Vec<i16>>();
    let _writer_thread = thread::spawn(move || {
        let stdout = io::stdout();
        let mut writer = BufWriter::with_capacity(64 * 1024, stdout.lock());
        let mut bytes = Vec::<u8>::with_capacity(64 * 1024);

        while let Ok(block) = rx.recv() {
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
            device
                .build_input_stream(
                    &stream_config,
                    move |data: &[f32], _| {
                        let mut mono = Vec::<f32>::with_capacity(data.len() / channels.max(1));
                        let mut out = Vec::<f32>::with_capacity(mono.capacity());
                        let mut pcm = Vec::<i16>::with_capacity(mono.capacity());

                        to_mono_f32(data, channels, |v| v, &mut mono);
                        if let Ok(mut rs) = resampler.lock() {
                            rs.process(&mono, &mut out);
                        }
                        if out.is_empty() {
                            return;
                        }
                        f32_to_i16(&out, &mut pcm);
                        let _ = tx.send(pcm);
                    },
                    error_callback,
                    None,
                )
                .map_err(|e| format!("failed to build input stream: {e}"))?
        }
        SampleFormat::I16 => {
            let tx = tx.clone();
            let resampler = Arc::clone(&resampler);
            device
                .build_input_stream(
                    &stream_config,
                    move |data: &[i16], _| {
                        let mut mono = Vec::<f32>::with_capacity(data.len() / channels.max(1));
                        let mut out = Vec::<f32>::with_capacity(mono.capacity());
                        let mut pcm = Vec::<i16>::with_capacity(mono.capacity());

                        to_mono_f32(data, channels, |v| v as f32 / i16::MAX as f32, &mut mono);
                        if let Ok(mut rs) = resampler.lock() {
                            rs.process(&mono, &mut out);
                        }
                        if out.is_empty() {
                            return;
                        }
                        f32_to_i16(&out, &mut pcm);
                        let _ = tx.send(pcm);
                    },
                    error_callback,
                    None,
                )
                .map_err(|e| format!("failed to build input stream: {e}"))?
        }
        SampleFormat::U16 => {
            let tx = tx.clone();
            let resampler = Arc::clone(&resampler);
            device
                .build_input_stream(
                    &stream_config,
                    move |data: &[u16], _| {
                        let mut mono = Vec::<f32>::with_capacity(data.len() / channels.max(1));
                        let mut out = Vec::<f32>::with_capacity(mono.capacity());
                        let mut pcm = Vec::<i16>::with_capacity(mono.capacity());

                        to_mono_f32(
                            data,
                            channels,
                            |v| (v as f32 / u16::MAX as f32) * 2.0 - 1.0,
                            &mut mono,
                        );
                        if let Ok(mut rs) = resampler.lock() {
                            rs.process(&mono, &mut out);
                        }
                        if out.is_empty() {
                            return;
                        }
                        f32_to_i16(&out, &mut pcm);
                        let _ = tx.send(pcm);
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
        "READY input_sample_rate={} target_sample_rate={} channels={}",
        input_sample_rate, config.target_sample_rate, channels
    );

    loop {
        thread::sleep(Duration::from_secs(60));
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
