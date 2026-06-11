import test from 'ava'

import rustPackage from '../index.js'

const { analyzeKeyFromPcm } = rustPackage

test('native exports key analysis entrypoint', (t) => {
  t.is(typeof analyzeKeyFromPcm, 'function')
})
