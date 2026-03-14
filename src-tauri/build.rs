fn main() {
  println!("cargo:rerun-if-changed=icons");
  println!("cargo:rerun-if-changed=icons/app-icon-source.png");
  println!("cargo:rerun-if-changed=tauri.conf.json");
  println!("cargo:rerun-if-changed=tauri.bundle.conf.json");
  tauri_build::build()
}
