import numpy as np
import soundfile as sf
from math import gcd
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

  x = torch.abs(
    torch.stft(
      x,
      n_fft=n_fft,
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


def load_classifier_audio(path, sample_rate, duration=None):
  librosa = _load_librosa()
  samples, _ = librosa.load(path, sr=sample_rate, duration=duration, mono=True)
  return signal.lfilter(FILTER_B, FILTER_A, samples)


def load_spectrogram_chunk(path, start_index, end_index=0):
  info = sf.info(path)
  samples = int(info.duration * info.samplerate)
  chunk_length = DEFAULT_CHUNK_SECONDS * info.samplerate
  start_sample = int(start_index * FRAME_STEP)
  end_sample = int(end_index * FRAME_STEP) if end_index else start_sample + chunk_length

  if start_sample >= samples:
    return None

  waveform, _ = sf.read(path, dtype="int16", start=start_sample, stop=end_sample)
  waveform = _to_float32(_to_mono(waveform))
  spectrogram = _build_spectrogram(waveform) * 255
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
    spectrogram_samples = waveform[: DEFAULT_CHUNK_SECONDS * info.samplerate]
    spectrogram = _build_spectrogram(spectrogram_samples) * 255
    import torch

    spectrogram = spectrogram.to(torch.uint8).tolist()

  return spectrogram, dense_waveform, info


def load_playback_audio(path, start_index, end_index):
  start_sample = int(start_index * FRAME_STEP)
  end_sample = int(end_index * FRAME_STEP)
  waveform, sample_rate = sf.read(
    path, dtype="int16", start=start_sample, stop=end_sample
  )
  waveform = _to_mono(waveform)
  duration = 0 if end_sample <= start_sample else (end_sample - start_sample) / sample_rate
  return waveform, sample_rate, duration


def prepare_playback_audio(
  path,
  start_index,
  end_index,
  expansion_rate=10.0,
  playback_sample_rate=DEFAULT_PLAYBACK_SAMPLE_RATE,
):
  waveform, sample_rate, duration = load_playback_audio(path, start_index, end_index)

  if len(waveform) == 0:
    return np.zeros(0, dtype=np.int16), playback_sample_rate, 0

  expansion_rate = max(float(expansion_rate), 1.0)
  target_resample_rate = int(round(playback_sample_rate * expansion_rate))
  factor_gcd = gcd(target_resample_rate, sample_rate)
  up = target_resample_rate // factor_gcd
  down = sample_rate // factor_gcd

  waveform_float = waveform.astype(np.float32) / 32768.0
  stretched = signal.resample_poly(waveform_float, up, down)
  stretched = np.clip(stretched, -1.0, 1.0)
  stretched_int16 = (stretched * 32767.0).astype(np.int16)

  return stretched_int16, playback_sample_rate, duration * expansion_rate
