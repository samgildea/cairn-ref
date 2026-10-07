import { describe, expect, it } from 'vitest';
import { summarizeRollup } from '../src/github';

describe('summarizeRollup', () => {
	it('is none without checks', () => {
		expect(summarizeRollup([])).toBe('none');
		expect(summarizeRollup(null)).toBe('none');
	});

	it('fails on any failing check run or status context', () => {
		expect(summarizeRollup([
			{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
			{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' },
		])).toBe('failing');
		expect(summarizeRollup([{ __typename: 'StatusContext', state: 'ERROR' }])).toBe('failing');
	});

	it('is pending while anything runs', () => {
		expect(summarizeRollup([
			{ __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: null },
			{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
		])).toBe('pending');
		expect(summarizeRollup([{ __typename: 'StatusContext', state: 'PENDING' }])).toBe('pending');
	});

	it('passes when everything succeeded, skipped, or was neutral', () => {
		expect(summarizeRollup([
			{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
			{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SKIPPED' },
			{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'NEUTRAL' },
			{ __typename: 'StatusContext', state: 'SUCCESS' },
		])).toBe('passing');
	});
});
