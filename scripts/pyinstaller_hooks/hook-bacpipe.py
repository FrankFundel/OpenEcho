from PyInstaller.utils.hooks import collect_data_files, collect_submodules


datas = collect_data_files("bacpipe")
hiddenimports = collect_submodules("bacpipe")
