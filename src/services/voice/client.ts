/**
 * Twilio Voice Client Abstraction (Phase 4 Foundation)
 * Client-side token fetcher prepared for WebRTC browser calling in Phase 5.
 */

export interface VoiceTokenResponse {
  token: string;
  identity: string;
  expiresInSeconds: number;
}

/**
 * Fetches short-lived Voice Access Token from server API endpoint.
 */
export async function fetchVoiceAccessToken(): Promise<VoiceTokenResponse | null> {
  try {
    const response = await fetch('/api/twilio/token', {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.warn('Voice token request failed:', errorData.error || response.statusText);
      return null;
    }

    const data: VoiceTokenResponse = await response.json();
    return data;
  } catch (error) {
    console.error('Error fetching Voice Access Token:', error);
    return null;
  }
}
