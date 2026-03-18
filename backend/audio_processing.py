import numpy as np
import soundfile as sf
from scipy import signal

FRAME_STEP = 128
DEFAULT_CHUNK_SECONDS = 2
DEFAULT_PLAYBACK_SAMPLE_RATE = 44100
FILTER_B, FILTER_A = signal.butter(10, 15000 / 120000, "highpass")


def _to_mono(samples):
  if isinstance(samples, np.ndarray) and samples.ndim > 1:
    return samples.mean(axis=1)
  return samples


def _to_float32(samples):
  if isinstance(samples, np.ndarray):
    return samples.astype(np.float32, copy=False)
  return np.asarray(samples, dtype=np.float32)


def _load_librosa():
  import librosa

  return librosa


def _preprocess_spectrogram(x, n_fft=512):
  import torch

  # Pad only on the right so frame 0 stays anchored to the real audio start.
  # This makes each spectrogram column line up with our 128-sample frame grid.
  signal_length = int(x.shape[-1])
  min_right_pad = max(n_fft - FRAME_STEP, 0)
  required_right_pad = max(n_fft - signal_length, 0)
  right_pad = max(min_right_pad, required_right_pad)
  if right_pad > 0:
    x = torch.nn.functional.pad(x, (0, right_pad))

  x = torch.abs(
    torch.stft(
      x,
      n_fft=n_fft,
      hop_length=FRAME_STEP,
      center=False,
      window=torch.hann_window(window_length=n_fft).to(x.device),
      return_complex=True,
    )
  )
  x = 20.0 * torch.log10(torch.clamp(x, min=1e-10))
  x -= 20.0 * torch.log10(torch.clamp(torch.max(x), min=1e-10))
  x = torch.abs(x - x.mean(dim=2, keepdim=True).repeat((1, 1, x.shape[2])))
  x /= x.amax(1, keepdim=True).amax(2, keepdim=True)
  return x.transpose(dim0=2, dim1=1)


def _build_spectrogram(waveform):
  import torch

  return _preprocess_spectrogram(torch.as_tensor(waveform).unsqueeze(0)).squeeze(0)


def _fit_spectrogram_width(spectrogram, target_width):
  import torch

  width = int(spectrogram.shape[0]) if spectrogram.ndim > 0 else 0
  bins = int(spectrogram.shape[1]) if spectrogram.ndim > 1 else 0
  next_width = max(int(target_width), 1)

  if width == next_width:
    return spectrogram
  if width <= 0:
    return torch.zeros(
      (next_width, bins),
      dtype=spectrogram.dtype,
      device=spectrogram.device,
    )
  if width > next_width:
    return spectrogram[:next_width]

  pad = spectrogram[-1:, :].repeat((next_width - width, 1))
  return torch.cat((spectrogram, pad), dim=0)


def load_classifier_audio(path, sample_rate, duration=None):
  librosa = _load_librosa()
  samples, _ = librosa.load(path, sr=sample_rate, duration=duration, mono=True)
  return signal.lfilter(FILTER_B, FILTER_A, samples)


def load_spectrogram_chunk(path, start_index, end_index=0):
  info = sf.info(path)
  samples = int(info.frames)
  if samples <= 0:
    return None

  chunk_length = DEFAULT_CHUNK_SECONDS * info.samplerate
  start_sample = max(int(start_index * FRAME_STEP), 0)
  if start_sample >= samples:
    start_sample = max(0, samples - FRAME_STEP)
  end_sample = (
    int(end_index * FRAME_STEP)
    if end_index
    else start_sample + chunk_length
  )
  end_sample = min(max(end_sample, start_sample + FRAME_STEP), samples)
  if end_sample <= start_sample:
    return None

  waveform, _ = sf.read(path, dtype="int16", start=start_sample, stop=end_sample)
  waveform = _to_float32(_to_mono(waveform))
  if len(waveform) == 0:
    return None

  target_frames = max(int(np.ceil((end_sample - start_sample) / FRAME_STEP)), 1)
  spectrogram = _build_spectrogram(waveform) * 255
  spectrogram = _fit_spectrogram_width(spectrogram, target_frames)
  import torch

  return spectrogram.to(torch.uint8).tolist()


def load_recording_preview(path, resolution=1000):
  info = sf.info(path)
  waveform, _ = sf.read(path, dtype="int16")
  waveform = _to_float32(_to_mono(waveform))

  if len(waveform) == 0:
    dense_waveform = []
    spectrogram = []
  else:
    indices = np.round(np.linspace(0, len(waveform) - 1, resolution)).astype(int)
    dense_waveform = waveform[indices].tolist()
    spectrogram_samples = waveform[: int(DEFAULT_CHUNK_SECONDS * info.samplerate)]
    target_frames = max(int(np.ceil(len(spectrogram_samples) / FRAME_STEP)), 1)
    spectrogram = _build_spectrogram(spectrogram_samples) * 255
    spectrogram = _fit_spectrogram_width(spectrogram, target_frames)
    import torch

    spectrogram = spectrogram.to(torch.uint8).tolist()

  return spectrogram, dense_waveform, info


def load_playback_audio(path, start_index, end_index):
  info = sf.info(path)
  total_samples = int(info.frames)
  if total_samples <= 0:
    sample_rate = int(info.samplerate) if info.samplerate else 0
    return np.zeros(0, dtype=np.float32), sample_rate, 0, 0.0, 0.0

  start_sample = max(int(start_index * FRAME_STEP), 0)
  end_sample = max(int(end_index * FRAME_STEP), start_sample + FRAME_STEP)
  if start_sample >= total_samples:
    start_sample = max(0, total_samples - FRAME_STEP)
  end_sample = min(end_sample, total_samples)
  if end_sample <= start_sample:
    end_sample = min(total_samples, start_sample + FRAME_STEP)

  waveform, sample_rate = sf.read(
    path, dtype="int16", start=start_sample, stop=end_sample
  )
  waveform = _to_float32(_to_mono(waveform))
  duration = (
    len(waveform) / sample_rate
    if sample_rate and len(waveform) > 0
    else 0
  )
  actual_start_frame = start_sample / FRAME_STEP
  actual_end_frame = end_sample / FRAME_STEP
  return waveform, sample_rate, duration, actual_start_frame, actual_end_frame


def prepare_playback_audio(
  path,
  start_index,
  end_index,
  expansion_rate=10.0,
  playback_sample_rate=DEFAULT_PLAYBACK_SAMPLE_RATE,
):
  waveform, sample_rate, duration, actual_start_frame, actual_end_frame = load_playback_audio(
    path,
    start_index,
    end_index,
  )

  if len(waveform) == 0:
    return np.zeros(0, dtype=np.int16), playback_sample_rate, 0, actual_start_frame, actual_end_frame

  expansion_rate = max(float(expansion_rate), 1.0)
  output_sample_rate = max(int(round(sample_rate / expansion_rate)), 4000)
  waveform_int16 = np.clip(waveform, -32768.0, 32767.0).astype(np.int16, copy=False)
  stretched_duration = len(waveform_int16) / output_sample_rate

  return (
    waveform_int16,
    output_sample_rate,
    stretched_duration,
    actual_start_frame,
    actual_end_frame,
  )
