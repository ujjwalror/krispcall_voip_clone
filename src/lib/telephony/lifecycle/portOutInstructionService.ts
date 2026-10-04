import 'server-only';
import {
  PortOutInstructionDTO,
  PortOutDomainState,
  ProviderPortOutInstructionFacts,
} from './types';

export interface GeneratePortOutInstructionParams {
  phoneNumberE164: string;
  status: PortOutDomainState;
  countryCode?: string;
  numberType?: string;
  accountNumberRequired?: boolean;
  pinRequired?: boolean;
  customerServiceAddressRequired?: boolean;
  facts?: ProviderPortOutInstructionFacts | null;
}

export class PortOutInstructionService {
  /**
   * Generates a provider-neutral Port-Out Instruction DTO for customer display.
   * STRICT INVARIANTS:
   * 1. Does NOT assume universal Account ID / PIN requirements.
   * 2. NEVER invents fake carrier credentials (e.g., VH-PRT-XXXXXX or fake PINs).
   * 3. NEVER exposes platform secrets (Twilio Account SID, Auth Token, API Key).
   * Returns only instructions and field requirements applicable to the current number/workflow.
   */
  static generateInstructions(
    params: GeneratePortOutInstructionParams
  ): PortOutInstructionDTO & {
    carrierAccountIdentifier?: string | null;
    carrierPortingPinMasked?: string | null;
  } {
    const status = params.status;
    const phoneNumberE164 = params.phoneNumberE164;
    const facts = params.facts || null;

    const accountNumberRequired = params.accountNumberRequired ?? Boolean(facts?.carrierAccountIdentifier);
    const pinRequired = params.pinRequired ?? Boolean(facts?.carrierPortingPinMasked);
    const customerServiceAddressRequired = params.customerServiceAddressRequired ?? true;

    let instructionSummary = '';
    const notes: string[] = [];

    // Append facts notes if available
    if (facts?.notes && facts.notes.length > 0) {
      notes.push(...facts.notes);
    }

    switch (status) {
      case 'requested':
      case 'instructions_ready':
        instructionSummary =
          'Provide these porting details to your new receiving carrier to initiate transfer away from VoIP Hub.';
        if (!notes.some((n) => n.includes('Submit this port-out request'))) {
          notes.push('Submit this port-out request through your new communications provider.');
        }
        if (accountNumberRequired && facts?.carrierAccountIdentifier) {
          notes.push('Your carrier will require your provider-authoritative account identifier.');
        } else if (accountNumberRequired) {
          notes.push('Transfer verification will proceed via standard CSR address matching.');
        }
        if (pinRequired && facts?.carrierPortingPinMasked) {
          notes.push('Your carrier will require your porting passcode.');
        }
        if (customerServiceAddressRequired) {
          notes.push('Your Customer Service Record (CSR) address must match your workspace verification address.');
        }
        break;

      case 'port_out_pending':
      case 'carrier_processing':
        instructionSummary =
          'Port-away request is in progress with your receiving carrier. Automatic number release is strictly paused.';
        notes.push('Transfer is being processed by your new provider.');
        notes.push('Do not delete your workspace or release the number while carrier transfer completes.');
        break;

      case 'action_required':
        instructionSummary =
          'Your receiving carrier reported a porting information mismatch. Please review details.';
        notes.push('Contact your new carrier to verify account details or CSR address matching.');
        break;

      case 'ported_out':
        instructionSummary = 'Number transfer away from VoIP Hub is completed.';
        notes.push('Number is now active with your new carrier.');
        break;

      case 'canceled':
        instructionSummary = 'Port-out request was canceled.';
        notes.push('Number remains active in your VoIP Hub workspace.');
        break;

      case 'manual_review_required':
      default:
        instructionSummary = 'Port-out status verification is under review by VoIP Hub operations.';
        notes.push('Our support team is verifying carrier porting progress.');
        break;
    }

    return {
      phoneNumberE164,
      status,
      instructionSummary,
      accountNumberRequired,
      pinRequired,
      customerServiceAddressRequired,
      carrierAccountIdentifier: facts?.credentialsAuthoritative ? facts.carrierAccountIdentifier : null,
      carrierPortingPinMasked: facts?.credentialsAuthoritative ? facts.carrierPortingPinMasked : null,
      notes: Array.from(new Set(notes)), // deduplicate
    };
  }
}
