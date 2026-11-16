/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { spaceAccentFor, spaceAccentIndex, spaceInitial, SPACE_COLORS } from '../../common/spaceColor.js';

suite('SpaceColor', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('palette has 8 distinct oklch entries', () => {
		assert.strictEqual(SPACE_COLORS.length, 8);
		for (const c of SPACE_COLORS) {
			assert.ok(c.startsWith('oklch('), `${c} is not an oklch color`);
		}
	});

	test('spaceAccentIndex is deterministic and bounded', () => {
		for (const id of ['a', 'b', 'space-1', 'root:/work/project-a', '']) {
			const i = spaceAccentIndex(id);
			assert.ok(i >= 0 && i < SPACE_COLORS.length, `index ${i} out of bounds for ${id}`);
			assert.strictEqual(i, spaceAccentIndex(id), `hash of ${id} must be stable`);
		}
	});

	test('spaceAccentFor returns the palette entry for the derived index', () => {
		const id = 'space-alpha';
		assert.strictEqual(spaceAccentFor(id), SPACE_COLORS[spaceAccentIndex(id)]);
	});

	test('spaceInitial returns the uppercased first letter and fallback', () => {
		assert.strictEqual(spaceInitial('alpha'), 'A');
		assert.strictEqual(spaceInitial('  beta'), 'B');
		assert.strictEqual(spaceInitial('Empty Space 1'), 'E');
		assert.strictEqual(spaceInitial(''), '?');
		assert.strictEqual(spaceInitial('   '), '?');
	});
});
