import importlib
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files


def walk_package_modules(package_name):
  package = importlib.import_module(package_name)
  modules = {package_name}
  package_paths = getattr(package, "__path__", None)
  if not package_paths:
    return sorted(modules)

  for package_path in package_paths:
    root = Path(package_path)

    for directory in root.rglob("*"):
      if not directory.is_dir():
        continue
      if directory.name == "__pycache__":
        continue
      rel_parts = directory.relative_to(root).parts
      if rel_parts:
        modules.add(f"{package_name}.{'.'.join(rel_parts)}")

    for file_path in root.rglob("*.py"):
      if "__pycache__" in file_path.parts:
        continue
      relative_path = file_path.relative_to(root)
      if file_path.name == "__init__.py":
        rel_parts = relative_path.parent.parts
      else:
        rel_parts = relative_path.with_suffix("").parts
      if rel_parts:
        modules.add(f"{package_name}.{'.'.join(rel_parts)}")

  return sorted(modules)


datas = collect_data_files("bacpipe")
module_collection_mode = {
  "bacpipe": "py",
}
hiddenimports = []
for package_name in (
  "bacpipe",
  "bacpipe.embedding_generation_pipelines",
  "bacpipe.embedding_evaluation",
  "bacpipe.model_specific_utils",
):
  hiddenimports.extend(walk_package_modules(package_name))

hiddenimports = sorted(set(hiddenimports))
