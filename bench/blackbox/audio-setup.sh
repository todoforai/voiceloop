#!/usr/bin/env bash
# bench/blackbox/audio-setup.sh — create (or tear down) the virtual audio pair the black-box
# rig uses. Any system under test just needs its audio pointed at these:
#   PULSE_SOURCE=bench_mic   (its microphone = what the driver plays)
#   PULSE_SINK=bench_spk     (its speakers   = what the driver records)
# Usage: audio-setup.sh up | down
set -e
case "${1:-up}" in
  up)
    pactl list short modules | grep -q bench_spk || pactl load-module module-null-sink sink_name=bench_spk sink_properties=device.description=bench_speaker >/dev/null
    pactl list short modules | grep -q bench_mic_sink || pactl load-module module-null-sink sink_name=bench_mic_sink sink_properties=device.description=bench_mic_feed >/dev/null
    pactl list short sources | grep -q '\bbench_mic\b' || pactl load-module module-remap-source master=bench_mic_sink.monitor source_name=bench_mic source_properties=device.description=bench_microphone >/dev/null
    echo "virtual audio up: mic=bench_mic  spk=bench_spk"
    ;;
  down)
    for m in $(pactl list short modules | grep -E 'bench_spk|bench_mic' | cut -f1); do pactl unload-module "$m"; done
    echo "virtual audio down"
    ;;
  *) echo "usage: $0 up|down"; exit 1;;
esac
