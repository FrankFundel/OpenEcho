from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs


datas = collect_data_files("torch")
binaries = collect_dynamic_libs("torch")
hiddenimports = [
  "torch",
  "torch._C",
  "torch._VF",
  "torch._tensor",
  "torch.backends",
  "torch.backends.mps",
  "torch.nn",
  "torch.nn.functional",
  "torch.nn.modules",
  "torch.optim",
  "torch.utils.data",
]
excludedimports = [
  "tensorboard",
  "torch.utils.tensorboard",
]
