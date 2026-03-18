from __future__ import annotations

import math
from functools import lru_cache
from pathlib import Path

import librosa
from scipy import signal
import torch
from torch import nn

from backend.paths import resource_root

BAT2_CHECKPOINT_PATH = resource_root() / "models" / "BigBAT.pth"
BAT_CLASS_LABELS = [
  "Rhinolophus ferrumequinum",
  "Rhinolophus hipposideros",
  "Myotis daubentonii",
  "Myotis brandtii",
  "Myotis mystacinus",
  "Myotis emarginatus",
  "Myotis nattereri",
  "Myotis myotis",
  "Myotis dasycneme",
  "Nyctalus noctula",
  "Nyctalus leisleri",
  "Pipistrellus pipistrellus",
  "Pipistrellus nathusii",
  "Pipistrellus kuhlii",
  "Eptesicus serotinus",
  "Eptesicus nilssonii",
  "Miniopterus schreibersii",
  "Vespertilio murinus",
]
BAT_CLASS_SHORT_LABELS = [
  "Rfer",
  "Rhip",
  "Mdaub",
  "Mbrandt",
  "Mmys",
  "Mem",
  "Mnat",
  "Mmyo",
  "Mdas",
  "Nnoc",
  "Nleis",
  "Ppip",
  "Pnat",
  "Pkuhl",
  "Eser",
  "Enil",
  "Mschreib",
  "Vmur",
]
BAT2_SAMPLE_RATE = 22050 * 10
BAT2_FILTER_B, BAT2_FILTER_A = signal.butter(
  10,
  15000 / 120000,
  "highpass",
)


@lru_cache(maxsize=1)
def get_bat_class_labels():
  return list(BAT_CLASS_LABELS)


def get_bat_class_short_labels():
  return list(BAT_CLASS_SHORT_LABELS)


class PreNorm(nn.Module):
  def __init__(self, dim, fn):
    super().__init__()
    self.norm = nn.LayerNorm(dim)
    self.fn = fn

  def forward(self, x, **kwargs):
    return self.fn(self.norm(x), **kwargs)


class FeedForward(nn.Module):
  def __init__(self, dim, hidden_dim, dropout=0.0):
    super().__init__()
    self.net = nn.Sequential(
      nn.Linear(dim, hidden_dim),
      nn.GELU(),
      nn.Dropout(dropout),
      nn.Linear(hidden_dim, dim),
      nn.Dropout(dropout),
    )

  def forward(self, x):
    return self.net(x)


class Attention(nn.Module):
  def __init__(self, dim, heads=8, dim_head=64, dropout=0.0):
    super().__init__()
    inner_dim = dim_head * heads
    project_out = not (heads == 1 and dim_head == dim)

    self.heads = heads
    self.scale = dim_head ** -0.5
    self.attend = nn.Softmax(dim=-1)
    self.dropout = nn.Dropout(dropout)
    self.to_qkv = nn.Linear(dim, inner_dim * 3, bias=False)
    self.to_out = nn.Sequential(
      nn.Linear(inner_dim, dim),
      nn.Dropout(dropout),
    ) if project_out else nn.Identity()

  def forward(self, x):
    qkv = self.to_qkv(x).chunk(3, dim=-1)
    batch_size, token_count, width = qkv[0].shape
    head_dim = width // self.heads
    q, k, v = (
      tensor.reshape((batch_size, token_count, self.heads, head_dim)).permute((0, 2, 1, 3))
      for tensor in qkv
    )

    attention = self.attend(torch.matmul(q, k.transpose(-1, -2)) * self.scale)
    attention = self.dropout(attention)
    output = torch.matmul(attention, v)
    output = output.permute((0, 2, 1, 3)).flatten(2, 3)
    return self.to_out(output)


class Transformer(nn.Module):
  def __init__(self, dim, depth, heads, dim_head, mlp_dim, dropout=0.0):
    super().__init__()
    self.layers = nn.ModuleList([])
    for _ in range(depth):
      self.layers.append(
        nn.ModuleList(
          [
            PreNorm(
              dim,
              Attention(dim, heads=heads, dim_head=dim_head, dropout=dropout),
            ),
            PreNorm(dim, FeedForward(dim, mlp_dim, dropout=dropout)),
          ]
        )
      )

  def forward(self, x):
    for attention, feed_forward in self.layers:
      x = attention(x) + x
      x = feed_forward(x) + x
    return x


class BAT2(nn.Module):
  def __init__(
    self,
    max_len,
    patch_len,
    patch_skip,
    d_model,
    num_classes,
    patch_embedding,
    nhead=2,
    dim_feedforward=32,
    num_layers=2,
    dropout=0.1,
    classifier_dropout=0.3,
  ):
    super().__init__()

    self.patch_len = patch_len
    self.patch_skip = patch_skip
    self.patch_embedding = patch_embedding
    self.cls_token = nn.Parameter(torch.randn(1, 1, d_model))
    self.pos_encoder = nn.Parameter(torch.randn(1, max_len + 1, d_model))
    self.dropout = nn.Dropout(classifier_dropout)
    self.transformer_encoder = Transformer(
      dim=d_model,
      depth=num_layers,
      heads=nhead,
      dim_head=16,
      mlp_dim=dim_feedforward,
      dropout=dropout,
    )
    self.classifier = nn.Sequential(nn.LayerNorm(d_model), nn.Linear(d_model, num_classes))
    self.d_model = d_model

  def forward(self, x):
    x = x.unfold(dimension=1, size=self.patch_len, step=self.patch_skip).transpose(3, 2)
    batch_size, token_count, patch_width, patch_height = x.shape
    x = x.reshape((batch_size * token_count, 1, patch_width, patch_height))
    x = self.patch_embedding(x)
    x = x.reshape((batch_size, token_count, self.d_model))
    cls_token = self.cls_token.repeat((batch_size, 1, 1))
    x = torch.cat((cls_token, x), dim=1)
    x += self.pos_encoder
    x = self.dropout(x)
    x = self.transformer_encoder(x)
    x = torch.mean(x[:, 1:], 1)
    return self.classifier(x)


def pad_and_slide_window(values, size, step):
  corrected_size = list(values.shape)
  corrected_size[0] = math.ceil(corrected_size[0] / size) * size
  padded = torch.zeros(corrected_size, device=values.device, dtype=values.dtype)
  padded[:len(values)] = values
  return padded.unfold(dimension=0, size=size, step=step)


def preprocess_bat2(x, n_fft=512):
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


def build_patch_embedding():
  return nn.Sequential(
    nn.Conv2d(1, 16, kernel_size=(3, 5), stride=(2, 3), padding=3),
    nn.BatchNorm2d(16),
    nn.ReLU(),
    nn.Conv2d(16, 32, kernel_size=(3, 5), stride=(2, 3), padding=3),
    nn.BatchNorm2d(32),
    nn.ReLU(),
    nn.MaxPool2d(kernel_size=3, stride=2, padding=1),
    nn.Conv2d(32, 32, kernel_size=(3, 3), stride=(2, 3), padding=1),
    nn.BatchNorm2d(32),
    nn.ReLU(),
    nn.Conv2d(32, 64, kernel_size=(3, 3), stride=(2, 3), padding=1),
    nn.BatchNorm2d(64),
    nn.ReLU(),
    nn.Conv2d(64, 64, kernel_size=(3, 3), stride=(2, 2), padding=1),
    nn.BatchNorm2d(64),
    nn.ReLU(),
    nn.Flatten(),
  )


class BacpipeBat2Classifier:
  def __init__(self, checkpoint_path, class_count):
    self.torch = torch
    self.checkpoint_path = Path(checkpoint_path)
    self.device = self.torch.device("cpu")
    self.model = BAT2(
      max_len=60,
      patch_len=44,
      patch_skip=22,
      d_model=64,
      num_classes=class_count,
      patch_embedding=build_patch_embedding(),
      nhead=2,
      dim_feedforward=32,
      num_layers=2,
    )
    self.model.load_state_dict(self.load_state_dict(self.checkpoint_path))
    self.model.to(self.device)
    self.model.eval()

  def predict(self, recording_path, proclen=0):
    duration = None if not proclen else proclen
    waveform, _ = librosa.load(
      str(recording_path),
      sr=BAT2_SAMPLE_RATE,
      duration=duration,
      mono=True,
    )
    waveform = signal.lfilter(BAT2_FILTER_B, BAT2_FILTER_A, waveform)
    samples_per_step = 22 * (512 // 4)
    windows = pad_and_slide_window(
      self.torch.tensor(waveform, dtype=self.torch.float32, device=self.device),
      (60 + 1) * samples_per_step,
      60 * samples_per_step,
    )
    features = preprocess_bat2(windows, 512)
    with self.torch.no_grad():
      prediction = self.torch.sigmoid(self.model(features)).mean(axis=0)
    return prediction.unsqueeze(0).cpu().numpy()

  def load_state_dict(self, checkpoint_path):
    try:
      return self.torch.load(
        checkpoint_path,
        map_location="cpu",
        weights_only=True,
      )
    except TypeError:
      return self.torch.load(
        checkpoint_path,
        map_location="cpu",
      )


__all__ = [
  "BAT2_CHECKPOINT_PATH",
  "BAT_CLASS_SHORT_LABELS",
  "BacpipeBat2Classifier",
  "get_bat_class_labels",
  "get_bat_class_short_labels",
]
