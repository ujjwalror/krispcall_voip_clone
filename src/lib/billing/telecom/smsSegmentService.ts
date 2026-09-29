import { SmsEncodingAnalysis } from './types';

// Standard GSM 03.38 Basic Character Set
const GSM7_BASIC = new Set<number>([
  10, 13, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47,
  48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64,
  65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90,
  97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 122,
  161, 163, 164, 165, 167, 191, 196, 197, 198, 199, 201, 209, 214, 216, 220, 223, 224, 228, 229, 230, 233, 241, 246, 248, 252,
  0x0391, 0x0392, 0x0393, 0x0394, 0x0395, 0x0396, 0x0397, 0x0398, 0x0399, 0x039a, 0x039b, 0x039c, 0x039d, 0x039e, 0x039f,
  0x03a0, 0x03a1, 0x03a3, 0x03a4, 0x03a5, 0x03a6, 0x03a7, 0x03a8, 0x03a9
]);

// GSM 03.38 Extension Table Characters (Each takes 2 septets in GSM-7)
const GSM7_EXTENSION = new Set<number>([
  94,  // ^
  123, // {
  125, // }
  92,  // \
  91,  // [
  126, // ~
  93,  // ]
  124, // |
  8364 // €
]);

export class SmsSegmentService {
  /**
   * Pure server-side function to analyze message text encoding and conservatively calculate segment count.
   * Uses integer arithmetic only.
   */
  public static analyze(body: string): SmsEncodingAnalysis {
    if (!body || body.length === 0) {
      return {
        encoding: 'GSM-7',
        characterCount: 0,
        estimatedSegments: 0,
        containsExtensionChars: false,
        containsUnicode: false,
      };
    }

    let isUnicode = false;
    let containsExtension = false;
    let gsmCharacterCount = 0;

    for (let i = 0; i < body.length; i++) {
      const code = body.charCodeAt(i);

      if (GSM7_EXTENSION.has(code)) {
        containsExtension = true;
        gsmCharacterCount += 2; // Extension character consumes 2 septets (Escape char + Char)
      } else if (GSM7_BASIC.has(code)) {
        gsmCharacterCount += 1;
      } else {
        isUnicode = true;
        break; // Message requires UCS-2 encoding
      }
    }

    if (isUnicode) {
      const charCount = body.length;
      // UCS-2: Single segment up to 70 code units. Multi-segment: 67 code units per segment.
      const estimatedSegments =
        charCount <= 70 ? 1 : Math.ceil(charCount / 67);

      return {
        encoding: 'UCS-2',
        characterCount: charCount,
        estimatedSegments,
        containsExtensionChars: false,
        containsUnicode: true,
      };
    }

    // GSM-7: Single segment up to 160 septets. Multi-segment: 153 septets per segment.
    const estimatedSegments =
      gsmCharacterCount <= 160 ? 1 : Math.ceil(gsmCharacterCount / 153);

    return {
      encoding: 'GSM-7',
      characterCount: gsmCharacterCount,
      estimatedSegments,
      containsExtensionChars: containsExtension,
      containsUnicode: false,
    };
  }

  /**
   * Helper to calculate pre-send segment estimation.
   */
  public static calculatePreSendSegmentCount(body: string): number {
    return this.analyze(body).estimatedSegments;
  }
}
