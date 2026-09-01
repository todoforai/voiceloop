#!/usr/bin/env bash
# bench/blackbox/audio-setup.sh — create (or tear down) the virtual audio pair the black-box
# rig uses. Any system under test just needs its audio pointed at these:
#   PULSE_SOURCE=bench_mic   (its microphone = what the driver plays)
#   PULSE_SINK=bench_spk     (its speakers   = what the driver records)
# Usage: audio-setup.sh up | down
#
# `up` remembers the real default source/sink first, and `down` puts them back. Without that the
# rig is a mic thief: loading a null-sink can move the system default onto bench_mic, and every app
# that opens "the microphone" afterwards records a device that is silent BY DESIGN — no error, no
# signal, just a browser that never hears you. Leaving these loaded cost us an afternoon of
# debugging a demo that was never broken.
set -e
STATE="${XDG_RUNTIME_DIR:-/tmp}/bench-audio-default"
case "${1:-up}" in
  up)
    # Save the pre-bench defaults ONCE: a second `up` must not overwrite them with bench_* names.
    [ -f "$STATE" ] || { printf '%s\n%s\n' "$(pactl get-default-source)" "$(pactl get-default-sink)" > "$STATE"; }
    pactl list short modules | grep -q bench_spk || pactl load-module module-null-sink sink_name=bench_spk sink_properties=device.description=bench_speaker >/dev/null
    pactl list short modules | grep -q bench_mic_sink || pactl load-module module-null-sink sink_name=bench_mic_sink sink_properties=device.description=bench_mic_feed >/dev/null
    pactl list short sources | grep -q '\bbench_mic\b' || pactl load-module module-remap-source master=bench_mic_sink.monitor source_name=bench_mic source_properties=device.description=bench_microphone >/dev/null
    echo "virtual audio up: mic=bench_mic  spk=bench_spk"
    ;;
  down)
    for m in $(pactl list short modules | grep -E 'bench_spk|bench_mic' | cut -f1); do pactl unload-module "$m" || true; done
    # Restore the real devices. Unloading alone is not enough: the default can be left pointing at a
    # now-dead bench_* name, which is just as silent as the fake device was.
    if [ -f "$STATE" ]; then
      { read -r src; read -r snk; } < "$STATE"
      case "$src" in bench_*|'') ;; *) pactl set-default-source "$src" 2>/dev/null || true;; esac
      case "$snk" in bench_*|'') ;; *) pactl set-default-sink   "$snk" 2>/dev/null || true;; esac
      rm -f "$STATE"
    fi
    echo "virtual audio down (real mic/speaker restored)"
    ;;
  *) echo "usage: $0 up|down"; exit 1;;
esac
