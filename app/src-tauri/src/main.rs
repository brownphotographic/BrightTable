/*
 * BrightTable // Copyright (C) 2026 Rob Brown
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

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
