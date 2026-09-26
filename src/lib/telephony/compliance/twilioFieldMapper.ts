import 'server-only';
import { ComplianceRequirementSnapshot } from './types';
import {
  CreateAddressParams,
  CreateEndUserParams,
  CreateSupportingDocumentParams,
  CreateBundleParams,
} from './providerComplianceAdapter';

export interface UnmappedFieldValue {
  requirementKey: string;
  fieldName: string;
  fieldValue: string;
  isEncrypted?: boolean;
}

export class TwilioFieldMapper {
  /**
   * Determines whether an Address resource is required by the provider/regulation.
   */
  static isAddressRequired(
    snapshot: ComplianceRequirementSnapshot,
    fieldValues: UnmappedFieldValue[]
  ): boolean {
    if (snapshot.requirementPayload && snapshot.requirementPayload.addressRequirement === 'required') {
      return true;
    }
    const hasAddressField = fieldValues.some(
      (f) =>
        f.fieldName.toLowerCase().includes('street') ||
        f.fieldName.toLowerCase().includes('address')
    );
    if (snapshot.numberType === 'local' || hasAddressField) {
      return true;
    }
    return false;
  }

  /**
   * Maps decrypted local field values into Twilio Address creation parameters.
   */
  static mapAddress(
    profileId: string,
    snapshot: ComplianceRequirementSnapshot,
    fieldValues: UnmappedFieldValue[]
  ): CreateAddressParams {
    const getValue = (keyName: string): string => {
      const match = fieldValues.find((f) => f.fieldName.toLowerCase() === keyName.toLowerCase() || f.fieldName.toLowerCase().includes(keyName.toLowerCase()));
      return match ? match.fieldValue : '';
    };

    const street = getValue('street') || getValue('address_line_1') || getValue('address') || 'Main Street';
    const city = getValue('city') || getValue('suburb') || getValue('locality') || 'City';
    const region = getValue('region') || getValue('state') || getValue('province') || '';
    const postalCode = getValue('postal_code') || getValue('postcode') || getValue('zip') || '0000';
    const customerName = getValue('customer_name') || getValue('full_name') || getValue('business_name') || 'Customer Name';

    return {
      friendlyName: `Address - Profile ${profileId.slice(0, 8)}`,
      customerName,
      street,
      city,
      region,
      postalCode,
      isoCountry: snapshot.countryCode.toUpperCase(),
    };
  }

  /**
   * Maps decrypted local field values into Twilio End User creation parameters.
   */
  static mapEndUser(
    profileId: string,
    snapshot: ComplianceRequirementSnapshot,
    fieldValues: UnmappedFieldValue[]
  ): CreateEndUserParams {
    const attributes: Record<string, string> = {};

    for (const f of fieldValues) {
      if (f.fieldValue) {
        attributes[f.fieldName] = f.fieldValue;
      }
    }

    const friendlyName = `EndUser - ${snapshot.endUserType} - ${profileId.slice(0, 8)}`;

    return {
      friendlyName,
      type: snapshot.endUserType === 'business' ? 'business' : 'individual',
      attributes,
    };
  }

  /**
   * Maps end user attributes based on type, legal name, canonical name components, and field values.
   */
  static mapEndUserAttributes(
    optsOrType: string | {
      endUserType: string;
      fieldValues?: UnmappedFieldValue[];
      legalName: string;
      canonicalGivenName?: string | null;
      canonicalFamilyName?: string | null;
      requirements?: Array<{ code?: string; fieldType?: string; isRequired?: boolean }>;
    },
    fieldValuesArg?: UnmappedFieldValue[],
    legalNameArg?: string,
    canonicalGivenNameArg?: string | null,
    canonicalFamilyNameArg?: string | null
  ): any {
    let endUserType: string;
    let fieldValues: UnmappedFieldValue[];
    let legalName: string;
    let canonicalGivenName: string | null | undefined;
    let canonicalFamilyName: string | null | undefined;
    let requirements: Array<{ code?: string; fieldType?: string; isRequired?: boolean }> | undefined;

    if (typeof optsOrType === 'object') {
      endUserType = optsOrType.endUserType;
      fieldValues = optsOrType.fieldValues || [];
      legalName = optsOrType.legalName || '';
      canonicalGivenName = optsOrType.canonicalGivenName;
      canonicalFamilyName = optsOrType.canonicalFamilyName;
      requirements = optsOrType.requirements;
    } else {
      endUserType = optsOrType;
      fieldValues = fieldValuesArg || [];
      legalName = legalNameArg || '';
      canonicalGivenName = canonicalGivenNameArg;
      canonicalFamilyName = canonicalFamilyNameArg;
    }

    const attributes: Record<string, string> = {};
    if (endUserType === 'business') {
      attributes['business_name'] = legalName;
    } else {
      const explicitGiven = canonicalGivenName || fieldValues.find((f) => f.fieldName === 'given_name' || f.fieldName === 'first_name')?.fieldValue;
      const explicitFamily = canonicalFamilyName || fieldValues.find((f) => f.fieldName === 'family_name' || f.fieldName === 'last_name')?.fieldValue;

      if (explicitGiven) {
        attributes['first_name'] = explicitGiven;
      }
      if (explicitFamily) {
        attributes['last_name'] = explicitFamily;
      }
    }

    for (const f of fieldValues) {
      if (f.fieldValue) {
        attributes[f.fieldName] = f.fieldValue;
      }
    }

    if (requirements) {
      const missingFields: string[] = [];
      for (const req of requirements) {
        if (req.isRequired && req.code) {
          if (!attributes[req.code]) {
            missingFields.push(req.code);
          }
        }
      }
      return {
        mappedAttributes: attributes,
        isComplete: missingFields.length === 0,
        missingFields,
      };
    }

    return attributes;
  }

  /**
   * Maps supporting document metadata into Twilio Supporting Document creation parameters.
   */
  static mapSupportingDocument(
    doc: {
      id: string;
      documentType: string;
      documentNumber?: string | null;
      fieldValues?: Record<string, any>;
    },
    _snapshot: ComplianceRequirementSnapshot
  ): CreateSupportingDocumentParams {
    const attributes: Record<string, string> = {};
    if (doc.documentNumber) {
      attributes['document_number'] = doc.documentNumber;
    }
    if (doc.fieldValues) {
      for (const [k, v] of Object.entries(doc.fieldValues)) {
        if (typeof v === 'string') attributes[k] = v;
      }
    }

    return {
      friendlyName: `Doc - ${doc.documentType} - ${doc.id.slice(0, 8)}`,
      type: doc.documentType,
      attributes,
    };
  }

  /**
   * Maps profile and requirement snapshot metadata into Twilio Bundle parameters.
   */
  static mapBundle(
    profileId: string,
    snapshot: ComplianceRequirementSnapshot,
    contactEmail: string
  ): CreateBundleParams {
    return {
      friendlyName: `Bundle - ${snapshot.countryCode.toUpperCase()} ${snapshot.numberType} ${snapshot.endUserType} - ${profileId.slice(0, 8)}`,
      email: contactEmail,
      regulationSid: snapshot.providerRegulationId || undefined,
      isoCountry: snapshot.countryCode.toUpperCase(),
      numberType: snapshot.numberType,
      endUserType: snapshot.endUserType,
    };
  }
}
