import 'server-only';
import { PortOutInstructionDTO, PortOutDomainState } from './types';

export interface GeneratePortOutInstructionParams {
  phoneNumberE164: string;
  status: PortOutDomainState;
  countryCode?: string;
  numberType?: string;
  accountNumberRequired?: boolean;
  pinRequired?: boolean;
  customerServiceAddressRequired?: boolean;
}

export class PortOutInstructionService {
  /**
   * Generates a provider-neutral Port-Out Instruction DTO for customer display.
   * STRICT INVARIANT: Does NOT assume universal Account ID / PIN requirements.
   * Returns only instructions and field requirements applicable to the current number/workflow.
   */
  static generateInstructions(
    params: GeneratePortOutInstructionParams
  ): PortOutInstructionDTO {
    const status = params.status;
    const phoneNumberE164 = params.phoneNumberE164;
    const accountNumberRequired = params.accountNumberRequired ?? true;
    const pinRequired = params.pinRequired ?? false;
    const customerServiceAddressRequired = params.customerServiceAddressRequired ?? true;

    let instructionSummary = '';
    const notes: string[] = [];

    switch (status) {
      case 'requested':
      case 'instructions_ready':
        instructionSummary =
          'Provide these porting details to your new receiving carrier to initiate transfer away from VoIP Hub.';
        notes.push('Submit this port-out request through your new communications provider.');
        if (accountNumberRequired) {
          notes.push('Your new carrier will require your VoIP Hub Account Identifier.');
        }
        if (pinRequired) {
          notes.push('Your new carrier will require your Porting Authorization PIN.');
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
        notes.push('Do not delete your workspace until carrier transfer completes.');
        break;

      case 'action_required':
        instructionSummary =
          'Your receiving carrier reported a porting information mismatch. Please review details.';
        notes.push('Contact your new carrier to verify account number, PIN, or CSR address.');
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
      notes,
    };
  }
}
