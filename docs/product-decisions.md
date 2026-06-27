# Product Decisions

## 2026-06-27: Starflow MVP Loop

Starflow is a mobile-first support surface for ADHD users who need to move from scattered thoughts to one doable next step.

One-breath pitch:

> Task apps give ADHD users another list to feel behind on. Starflow uses Gemini to turn any overwhelming spark -- creative, admin, or emotional -- into one kind, doable next step.

The core loop is:

1. Scatter: capture what the user is thinking right now with minimal structure.
2. Flow: use AI to triage the capture into one focus and tiny executable steps.
3. Reflect: prompt a short non-judgmental check-in so the system learns the user's patterns.
4. Adjust: keep a context-aware chat available so the user can shrink, reorder, or reframe the plan without leaving the screen.

The first screen should be the usable app, not a marketing landing page. The user can immediately brain-dump, dictate, triage, reflect, and ask the overlay chat for adjustments.

## AI Roles

The product frames AI as an ADK-style multi-agent system:

- Sense Agent: normalize voice, image, or text into a spark. Image capture is important because a messy room photo can become an emotional spark.
- Classifier Agent: label the spark as creative, life-admin, emotional, recurring, urgent, or long-term.
- Triage Agent: ask only the one or two questions that matter for this spark type, such as energy, urgency, emotional load, or time.
- Coach Agents: Creative Coach, Life-Admin Coach, and Emotional Reset Coach share the same loop with different voice.
- Breakdown Agent: decompose into tiny steps and pick exactly one first step.
- Adjustment Agent: receive task edits/completions/resistance and change the active task.

The assistant should avoid shame, broad motivational advice, and perfection framing. It should prefer concrete next actions, small scopes, and language that supports returning to flow.

The event router receives user events, runs context/task extraction/prioritization/breakdown, writes to the shared task store, and updates the active dashboard.

## Demo Script

Use three sparks in roughly 90 seconds:

- Creative: "I want to build an app" -> low-energy triage -> "Write one sentence on who it helps" -> optional Stitch handoff.
- Life admin: "Deal with my taxes" -> "Create a folder called Taxes 2026" -> optional Google Tasks handoff.
- Emotional: photo of a messy room -> Gemini detects shame/overwhelm -> Emotional Reset Coach -> "Clear only the nearest surface for 2 minutes."

End on the emotional spark. It proves Starflow is not just a productivity tracker.

## Google Tie-Ins

- Capture: Gemini multimodal for text, voice transcript, and image input.
- Classify/Triage: Gemini structured output.
- Specialist coaches: Agent Development Kit multi-agent handoff.
- Creative app spark: route a chosen step into Stitch.
- Schedule/commit: Google Calendar or Google Tasks API for the one step.
- Progress glow: Firestore-backed streak/star map.

## Voice Input

Google Cloud Speech-to-Text is available for productized transcription and supports streaming microphone-style use cases. It is the right upgrade path if Starflow needs stored audio, consistent cross-platform transcription behavior, diarization, or server-side transcript control.

For the hackathon MVP, use mobile OS keyboard dictation and optional browser `SpeechRecognition` as progressive enhancement. This avoids audio upload, storage, consent, and quota complexity while still supporting the main user need: quickly getting thoughts into text.

References:

- Google Cloud Speech-to-Text: https://cloud.google.com/speech-to-text
- Google Cloud streaming transcription docs: https://docs.cloud.google.com/speech-to-text/docs/v1/transcribe-streaming-audio
- MDN Web Speech API: https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API
- MDN `SpeechRecognition` compatibility note: https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition
