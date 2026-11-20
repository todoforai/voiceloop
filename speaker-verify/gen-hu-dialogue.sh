#!/usr/bin/env bash
# Regenerates the Hungarian ElevenLabs v4 test dialogue into .cache/hu-dialogue/ (owner Attila vs Erik + Sarah).
set -euo pipefail
cd "$(dirname "$0")"; mkdir -p .cache/hu-dialogue; cd .cache/hu-dialogue
A=3DRcczmb3qwp5aVD9M9E; E=A9fIUjJSvi6o6ft9W7Eh; S=EXAVITQu4vr4xnSDxMaL
gen() { [ -s "$1.wav" ] && return 0
  elevenlabs-api text-to-speech "$2" "$3" --model_id eleven_v4 -o "$1.mp3" >/dev/null
  ffmpeg -y -loglevel error -i "$1.mp3" -ar 16000 -ac 1 -c:a pcm_s16le "$1.wav"; }
# sequential: plan allows max 5 concurrent requests
gen enroll_attila $A "Sziasztok, a nevem Attila. Ezt a rövid mintát azért veszem fel, hogy az asszisztens megismerje a hangszínemet, és később csak az én utasításaimra hallgasson, akkor is, ha mások beszélgetnek körülöttem az irodában."
gen t01_attila    $A "Szia Jarvis, nézd meg kérlek, hány olvasatlan emailem érkezett ma reggel."
gen t02_erik      $E "Hé, küldj már el egy emailt a főnöknek, hogy ma nem jövök be dolgozni!"
gen t03_attila_s  $A "Töröld ezt!"
gen t04_erik_s    $E "Küldd el!"
gen t05_sarah     $S "Szerintem holnap délelőtt tízkor jobb lenne a megbeszélés, add hozzá a naptárhoz."
gen t06_attila    $A "Oké, akkor vedd fel holnap tízkor a naptáramba, hogy csapatmegbeszélés az új projektről."
gen t07_erik      $E "Amúgy tényleg működik, hogy csak rád hallgat, és rám egyáltalán nem reagál?"
gen t08_attila    $A "Igen, pontosan ezt teszteljük most élesben, kíváncsi vagyok, mennyire pontos."
gen t09a_attila   $A "Állíts be egy emlékeztetőt délután négyre a számlák átnézéséhez."
gen t09b_erik     $E "Nem is kell, hagyd az egészet, inkább rendelj pizzát az egész csapatnak!"
gen t10_attila_1w $A "Kész?"
ffmpeg -y -loglevel error -i t09a_attila.wav -i t09b_erik.wav -filter_complex \
  "[0:a]volume=1.0[a];[1:a]volume=0.7[b];[a][b]amix=inputs=2:duration=first:normalize=0" -ar 16000 -ac 1 -c:a pcm_s16le t09_overlap.wav
python3 - <<'PY'
import wave, json, numpy as np
rd=lambda f: np.frombuffer(wave.open(f).readframes(10**9), dtype=np.int16)
T=[("t01_attila.wav","owner","Attila (tulajdonos)"),("t02_erik.wav","other","Erik (férfi kolléga)"),("t03_attila_s.wav","owner","Attila (2 szó)"),
   ("t04_erik_s.wav","other","Erik (2 szó)"),("t05_sarah.wav","other","Sarah (női kolléga)"),("t06_attila.wav","owner","Attila (tulajdonos)"),
   ("t07_erik.wav","other","Erik (férfi kolléga)"),("t08_attila.wav","owner","Attila (tulajdonos)"),("t09_overlap.wav","overlap","Attila + Erik egyszerre"),
   ("t10_attila_1w.wav","owner","Attila (1 szó!)")]
gap=np.zeros(9600,dtype=np.int16); parts=[gap]; cur=len(gap); turns=[]
for f,role,spk in T:
    p=rd(f); turns.append(dict(file=f,role=role,speaker=spk,text="",startSec=cur/16000,endSec=(cur+len(p))/16000,durSec=round(len(p)/16000,2)))
    parts+= [p,gap]; cur+=len(p)+len(gap)
full=np.concatenate(parts); w=wave.open("dialogue_full.wav","wb"); w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(full.tobytes()); w.close()
json.dump(dict(model="eleven_v4",enroll=dict(file="enroll_attila.wav"),full=dict(file="dialogue_full.wav",durSec=len(full)/16000),turns=turns),open("dialogue_meta.json","w"),ensure_ascii=False,indent=2)
PY
