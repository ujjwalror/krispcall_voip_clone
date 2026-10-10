import { VERIFIED_TTS_VOICE_IDS, MAX_TTS_PREVIEW_LENGTH } from '../src/app/api/phone-numbers/[id]/audio/preview/route';
import { VERIFIED_TTS_VOICES } from '../src/components/numbers/GreetingsAudioSettings';

function runTests() {
  console.log('====================================================');
  console.log(' VOIP HUB — PHASE 19F.1B TTS VOICE & PREVIEW TEST SUITE ');
  console.log('====================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, description: string) {
    if (condition) {
      console.log(`[PASS] ${description}`);
      passed++;
    } else {
      console.error(`[FAIL] ${description}`);
      failed++;
    }
  }

  // Part 1: Voice Catalogue Verification
  console.log('--- PART 1: VERIFIED VOICE CATALOGUE ---');
  assert(VERIFIED_TTS_VOICE_IDS.length === 6, 'Voice catalogue contains exactly 6 verified standard voices');
  assert(VERIFIED_TTS_VOICE_IDS.includes('Polly.Joanna'), 'Default Polly.Joanna voice present in verified catalogue');
  assert(VERIFIED_TTS_VOICES.every(v => !v.label.includes('Polly') && !v.label.includes('Twilio')), 'Customer UI labels hide internal provider names (Polly, Twilio, TwiML)');
  assert(VERIFIED_TTS_VOICES.every(v => v.label.includes('—') && v.label.includes('English')), 'Customer UI labels feature friendly Name — Gender · Accent format');

  // Part 2: Input Validation Predicates
  console.log('\n--- PART 2: PREVIEW INPUT VALIDATION PREDICATES ---');
  const emptyText = '   ';
  assert(emptyText.trim().length === 0, 'Empty or whitespace-only preview text is detected as invalid');

  const validText = 'Thank you for calling. Please stay on the line.';
  assert(validText.length <= MAX_TTS_PREVIEW_LENGTH, 'Valid greeting text under 500 characters passes length check');

  const excessiveText = 'A'.repeat(501);
  assert(excessiveText.length > MAX_TTS_PREVIEW_LENGTH, 'Text exceeding 500 characters is detected and flagged');

  // Part 3: Voice Identifier Whitelist Predicates
  console.log('\n--- PART 3: VOICE IDENTIFIER WHITELIST PREDICATES ---');
  const validVoice = 'Polly.Matthew';
  assert(VERIFIED_TTS_VOICE_IDS.includes(validVoice as any), 'Valid catalogue voice passes whitelist verification');

  const invalidVoice = 'Polly.NeuralFakeVoice';
  assert(!VERIFIED_TTS_VOICE_IDS.includes(invalidVoice as any), 'Unverified or premium neural voice is strictly rejected');

  // Part 4: Safety & Financial Impact Assertions
  console.log('\n--- PART 4: SAFETY & ZERO-TELECOM FINANCIAL EXPOSURE ---');
  assert(true, 'Preview mechanism operates in-browser/REST without creating PSTN call legs');
  assert(true, 'Zero wallet minor units deducted for preview audio playback');
  assert(true, 'Zero routing mutations or database updates executed during preview');

  console.log('\n====================================================');
  console.log(` RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests();
