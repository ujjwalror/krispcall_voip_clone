import * as fs from 'fs';
import * as path from 'path';
import Module from 'module';

// Mock server-only package for tsx scripts
const originalRequire = Module.prototype.require;
// @ts-ignore
Module.prototype.require = function (id: string) {
  if (id === 'server-only') {
    return {};
  }
  return originalRequire.apply(this, arguments as any);
};

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exit(1);
  } else {
    console.log(`PASS: ${message}`);
  }
}

async function runTests() {
  console.log('--- Phase 12.1 Canonical Individual Name Fix Tests ---');

  const { TwilioFieldMapper } = await import('/Users/ritikchoudhary/Downloads/Kripscall_clone/src/lib/telephony/compliance/twilioFieldMapper');
  type RegulatoryRequirement = import('/Users/ritikchoudhary/Downloads/Kripscall_clone/src/lib/telephony/compliance/types').RegulatoryRequirement;

  const reqFirstName: RegulatoryRequirement = {
    requirementId: 'REQ_1',
    endUserType: 'individual',
    fieldType: 'text',
    friendlyName: 'First Name',
    code: 'first_name',
    description: 'First name',
    isRequired: true,
  };

  const reqLastName: RegulatoryRequirement = {
    requirementId: 'REQ_2',
    endUserType: 'individual',
    fieldType: 'text',
    friendlyName: 'Last Name',
    code: 'last_name',
    description: 'Last name',
    isRequired: true,
  };

  const reqBusinessName: RegulatoryRequirement = {
    requirementId: 'REQ_3',
    endUserType: 'business',
    fieldType: 'text',
    friendlyName: 'Business Name',
    code: 'business_name',
    description: 'Legal Business Name',
    isRequired: true,
  };

  // Test 1: explicit given_name maps to required first_name
  {
    const res = TwilioFieldMapper.mapEndUserAttributes({
      endUserType: 'individual',
      requirements: [reqFirstName],
      legalName: 'Johnathan Edward Doe',
      canonicalGivenName: 'Johnathan',
    });
    assert(res.mappedAttributes['first_name'] === 'Johnathan', '1. explicit given_name maps to required first_name');
  }

  // Test 2: explicit family_name maps to required last_name
  {
    const res = TwilioFieldMapper.mapEndUserAttributes({
      endUserType: 'individual',
      requirements: [reqLastName],
      legalName: 'Johnathan Edward Doe',
      canonicalFamilyName: 'Doe',
    });
    assert(res.mappedAttributes['last_name'] === 'Doe', '2. explicit family_name maps to required last_name');
  }

  // Test 3: both explicit values map correctly
  {
    const res = TwilioFieldMapper.mapEndUserAttributes({
      endUserType: 'individual',
      requirements: [reqFirstName, reqLastName],
      legalName: 'Johnathan Edward Doe',
      canonicalGivenName: 'Johnathan',
      canonicalFamilyName: 'Doe',
    });
    assert(
      res.mappedAttributes['first_name'] === 'Johnathan' && res.mappedAttributes['last_name'] === 'Doe',
      '3. both explicit values map correctly'
    );
  }

  // Test 4: missing required given_name fails closed
  {
    const res = TwilioFieldMapper.mapEndUserAttributes({
      endUserType: 'individual',
      requirements: [reqFirstName, reqLastName],
      legalName: 'Johnathan Doe',
      canonicalFamilyName: 'Doe',
    });
    assert(
      res.isComplete === false && res.missingFields.includes('first_name'),
      '4. missing required given_name fails closed'
    );
  }

  // Test 5: missing required family_name fails closed
  {
    const res = TwilioFieldMapper.mapEndUserAttributes({
      endUserType: 'individual',
      requirements: [reqFirstName, reqLastName],
      legalName: 'Johnathan Doe',
      canonicalGivenName: 'Johnathan',
    });
    assert(
      res.isComplete === false && res.missingFields.includes('last_name'),
      '5. missing required family_name fails closed'
    );
  }

  // Test 6: legal_name containing two words is NOT split
  {
    const res = TwilioFieldMapper.mapEndUserAttributes({
      endUserType: 'individual',
      requirements: [reqFirstName, reqLastName],
      legalName: 'John Doe',
    });
    assert(
      res.mappedAttributes['first_name'] === undefined &&
        res.mappedAttributes['last_name'] === undefined &&
        res.missingFields.includes('first_name') &&
        res.missingFields.includes('last_name'),
      '6. legal_name containing two words is NOT split'
    );
  }

  // Test 7: legal_name containing one word is NOT split
  {
    const res = TwilioFieldMapper.mapEndUserAttributes({
      endUserType: 'individual',
      requirements: [reqFirstName, reqLastName],
      legalName: 'Cher',
    });
    assert(
      res.mappedAttributes['first_name'] === undefined &&
        res.mappedAttributes['last_name'] === undefined &&
        res.missingFields.includes('first_name') &&
        res.missingFields.includes('last_name'),
      '7. legal_name containing one word is NOT split'
    );
  }

  // Test 8: multi-part legal_name is NOT split
  {
    const res = TwilioFieldMapper.mapEndUserAttributes({
      endUserType: 'individual',
      requirements: [reqFirstName, reqLastName],
      legalName: 'Mary Elizabeth Winstead Smith',
    });
    assert(
      res.mappedAttributes['first_name'] === undefined &&
        res.mappedAttributes['last_name'] === undefined,
      '8. multi-part legal_name is NOT split'
    );
  }

  // Test 9: existing Individual profile without canonical names remains valid but incomplete when current provider requires them
  {
    const res = TwilioFieldMapper.mapEndUserAttributes({
      endUserType: 'individual',
      requirements: [reqFirstName, reqLastName],
      legalName: 'Jane Smith',
      canonicalGivenName: null,
      canonicalFamilyName: null,
    });
    assert(res.isComplete === false, '9. existing Individual profile without canonical names remains incomplete when required');
  }

  // Test 10: provider context not requiring given_name does not request it
  {
    const res = TwilioFieldMapper.mapEndUserAttributes({
      endUserType: 'individual',
      requirements: [reqLastName],
      legalName: 'Jane Smith',
      canonicalFamilyName: 'Smith',
    });
    assert(
      res.isComplete === true && !res.missingFields.includes('first_name'),
      '10. provider context not requiring given_name does not request it'
    );
  }

  // Test 11: provider context not requiring family_name does not request it
  {
    const res = TwilioFieldMapper.mapEndUserAttributes({
      endUserType: 'individual',
      requirements: [reqFirstName],
      legalName: 'Jane Smith',
      canonicalGivenName: 'Jane',
    });
    assert(
      res.isComplete === true && !res.missingFields.includes('last_name'),
      '11. provider context not requiring family_name does not request it'
    );
  }

  // Test 12: profile reuse reuses explicit canonical names
  {
    const existingProfile = {
      id: 'prof_123',
      legalName: 'Jane Alice Smith',
      givenName: 'Jane',
      familyName: 'Smith',
    };
    const res = TwilioFieldMapper.mapEndUserAttributes({
      endUserType: 'individual',
      requirements: [reqFirstName, reqLastName],
      legalName: existingProfile.legalName,
      canonicalGivenName: existingProfile.givenName,
      canonicalFamilyName: existingProfile.familyName,
    });
    assert(
      res.isComplete && res.mappedAttributes['first_name'] === 'Jane' && res.mappedAttributes['last_name'] === 'Smith',
      '12. profile reuse reuses explicit canonical names'
    );
  }

  // Test 13: reuse requests only missing canonical component
  {
    const existingProfileWithGivenOnly = {
      id: 'prof_124',
      legalName: 'Jane Smith',
      givenName: 'Jane',
      familyName: null,
    };
    const res = TwilioFieldMapper.mapEndUserAttributes({
      endUserType: 'individual',
      requirements: [reqFirstName, reqLastName],
      legalName: existingProfileWithGivenOnly.legalName,
      canonicalGivenName: existingProfileWithGivenOnly.givenName,
      canonicalFamilyName: existingProfileWithGivenOnly.familyName,
    });
    assert(
      res.mappedAttributes['first_name'] === 'Jane' &&
        res.missingFields.length === 1 &&
        res.missingFields[0] === 'last_name',
      '13. reuse requests only missing canonical component'
    );
  }

  // Test 14: Business business_name mapping unchanged
  {
    const res = TwilioFieldMapper.mapEndUserAttributes({
      endUserType: 'business',
      requirements: [reqBusinessName],
      legalName: 'Acme Corp Pty Ltd',
    });
    assert(
      res.isComplete && res.mappedAttributes['business_name'] === 'Acme Corp Pty Ltd',
      '14. Business business_name mapping unchanged'
    );
  }

  // Test 15: no production legal-name splitting remains
  {
    const srcDir = path.join(process.cwd(), 'src');
    function searchSplitting(dir: string): boolean {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          if (searchSplitting(fullPath)) return true;
        } else if (file.endsWith('.ts') || file.endsWith('.tsx')) {
          const content = fs.readFileSync(fullPath, 'utf8');
          if (/legal_?name.*\.split\(/i.test(content)) {
            console.error(`Found legal name splitting in ${fullPath}`);
            return true;
          }
        }
      }
      return false;
    }
    const foundSplitting = searchSplitting(srcDir);
    assert(!foundSplitting, '15. no production legal-name splitting remains');
  }

  console.log('\nALL 15 CANONICAL INDIVIDUAL NAME FIX TESTS PASSED SUCCESSFULLY!');
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
