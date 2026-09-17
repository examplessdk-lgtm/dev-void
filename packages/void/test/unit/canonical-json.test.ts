import { defineCanonicalJsonTests } from '../../../../test/canonical-json-contract.ts';
import { canonicalJson } from '../../src/migrations/canonical-json.ts';

defineCanonicalJsonTests(canonicalJson);
