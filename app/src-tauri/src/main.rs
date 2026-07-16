// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// glibc's malloc keeps freed memory in per-thread arenas rather than
// returning it to the OS, and this app's Tokio blocking-thread pool
// (thumbnail fetches, sidecar I/O - see io_guard::guarded_spawn_blocking)
// churns through many short-lived threads doing bursty medium-sized
// allocations, which is exactly the pattern that fragments those arenas
// worst. mimalloc returns freed pages far more aggressively, which is the
// standard fix for RSS ballooning under this workload shape despite no
// actual logical leak in the app's own data structures.
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

fn main() {
  app_lib::run();
}
