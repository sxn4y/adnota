// Hide the console window in release builds on Windows. In debug it stays visible,
// because a panic message printed to nowhere is worse than an extra window.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    adnota_lib::run()
}