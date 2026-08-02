import { describe, expect, it } from 'vitest';
import { hiddenSpawnOptions } from '../src/core/process';

describe('hidden subprocess boundary', () => {
  it('forces pipe-only execution without a Windows command shell or visible console', () => {
    const options = hiddenSpawnOptions({ shell: true, detached: true, windowsHide: false, cwd: 'C:\\work' });
    expect(options).toMatchObject({ shell: false, detached: false, windowsHide: true, stdio: 'pipe', cwd: 'C:\\work' });
  });
});
