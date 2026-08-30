#!/usr/bin/env python
# bench/blackbox/sut-pipecat.py — Pipecat as a black-box SUT for the bench rig.
# Same providers as voiceloop's winning config (Deepgram STT + ElevenLabs flash TTS) and the
# same mock LLM brain (bench/server.js on :7777), so the row isolates ORCHESTRATION, not models.
# Pattern: pipecat examples/getting-started/06a-voice-agent-local.py (PipelineWorker/WorkerRunner).
#
# Run (venv has pipecat[local,deepgram,elevenlabs,silero] + pyaudio):
#   PULSE_SOURCE=bench_mic PULSE_SINK=bench_spk DEEPGRAM_API_KEY=… ELEVENLABS_API_KEY=… \
#     /tmp/pipecat-venv/bin/python bench/blackbox/sut-pipecat.py
# Prints SUT_READY on stdout once the pipeline is live (run-proc.js waits for it).

import asyncio
import os
import sys

from loguru import logger

from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker, ProcessorUnusablePolicy
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.services.deepgram.stt import DeepgramSTTService
from pipecat.services.elevenlabs.tts import ElevenLabsTTSService
from pipecat.services.openai.llm import OpenAILLMService
from pipecat.transports.local.audio import LocalAudioTransport, LocalAudioTransportParams
from pipecat.workers.runner import WorkerRunner

logger.remove(0)
logger.add(sys.stderr, level="DEBUG")


def pulse_device_index() -> int:
    """PyAudio index of the 'pulse' device — honors PULSE_SOURCE/PULSE_SINK env."""
    import pyaudio

    pa = pyaudio.PyAudio()
    try:
        for i in range(pa.get_device_count()):
            if pa.get_device_info_by_index(i)["name"] == "pulse":
                return i
    finally:
        pa.terminate()
    raise RuntimeError("no 'pulse' pyaudio device")


async def main():
    pulse = pulse_device_index()
    transport = LocalAudioTransport(
        LocalAudioTransportParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            input_device_index=pulse,
            output_device_index=pulse,
        )
    )

    stt = DeepgramSTTService(api_key=os.environ["DEEPGRAM_API_KEY"])

    tts = ElevenLabsTTSService(
        api_key=os.environ["ELEVENLABS_API_KEY"],
        settings=ElevenLabsTTSService.Settings(
            voice="JBFqnCBsd6RMkjVDRZzb",
            model="eleven_flash_v2_5",
        ),
    )

    # The bench mock LLM: fixed scripted responses, 300ms TTFT, 300 chars/s — same brain for every SUT.
    # It selects the scripted turn by counting user messages; Pipecat's aggregator sometimes emits one
    # utterance as two user messages (split STT finals), so merge consecutive user messages — request
    # normalization to the mock's one-user-message-per-turn contract, no timing change. Limitation:
    # if Pipecat swallows a reply (self-interruption), two REAL turns sit adjacent and get merged too,
    # shifting the script by one — disclosed in RESULTS.md, not repairable at the request layer.
    class MockLLMService(OpenAILLMService):
        def build_chat_completion_params(self, params_from_context):
            params = super().build_chat_completion_params(params_from_context)
            merged = []
            for m in params["messages"]:
                if (merged and m["role"] == "user" and merged[-1]["role"] == "user"
                        and isinstance(m.get("content"), str) and isinstance(merged[-1].get("content"), str)):
                    merged[-1] = {"role": "user", "content": f"{merged[-1]['content']} {m['content']}"}
                else:
                    merged.append(dict(m))
            params["messages"] = merged
            return params

    llm = MockLLMService(api_key="x", base_url="http://localhost:7777/v1")

    context = LLMContext()
    user_aggregator, assistant_aggregator = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(vad_analyzer=SileroVADAnalyzer()),
    )

    pipeline = Pipeline(
        [
            transport.input(),
            stt,
            user_aggregator,
            llm,
            tts,
            transport.output(),
            assistant_aggregator,
        ]
    )

    worker = PipelineWorker(
        pipeline,
        params=PipelineParams(enable_metrics=True),
        processor_unusable_policy=ProcessorUnusablePolicy.END,
    )

    @worker.event_handler("on_pipeline_started")
    async def on_pipeline_started(worker, frame):
        print("SUT_READY", flush=True)

    runner = WorkerRunner(handle_sigterm=True)
    await runner.add_workers(worker)
    # No greeting: the bench "person" speaks first; the mock LLM scripts every reply.
    await runner.run()


if __name__ == "__main__":
    asyncio.run(main())
