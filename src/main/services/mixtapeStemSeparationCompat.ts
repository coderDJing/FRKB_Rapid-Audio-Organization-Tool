import * as shared from './mixtapeStemSeparationShared'

const { normalizeText, runProbeProcess } = shared

export const probeTorchDeviceCompatibility = async (params: {
  pythonPath: string
  env: NodeJS.ProcessEnv
  scriptLines: string[]
}) => {
  try {
    const result = await runProbeProcess({
      command: params.pythonPath,
      args: ['-c', params.scriptLines.join('\n')],
      env: params.env,
      timeoutMs: shared.STEM_DEVICE_COMPATIBILITY_TIMEOUT_MS,
      maxStdoutLen: 1000,
      maxStderrLen: 1000
    })
    const stdoutText = normalizeText(result.stdout, 600)
    const stderrText = normalizeText(result.stderr, 600)
    if (result.status === 0 && !result.timedOut) {
      return {
        ok: true,
        error: ''
      }
    }
    return {
      ok: false,
      error: result.error || stderrText || stdoutText || `compatibility exit ${result.status ?? -1}`
    }
  } catch (error) {
    return {
      ok: false,
      error: normalizeText(error instanceof Error ? error.message : String(error || ''), 600)
    }
  }
}

export const probeDirectmlDemucsCompatibility = async (params: {
  pythonPath: string
  env: NodeJS.ProcessEnv
  directmlDevice: string
}) => {
  const device = normalizeText(params.directmlDevice, 80) || 'privateuseone:0'
  return await probeTorchDeviceCompatibility({
    pythonPath: params.pythonPath,
    env: params.env,
    scriptLines: [
      'import torch',
      'import torch_directml',
      `device = ${JSON.stringify(device)}`,
      'x = torch.randn(2048, device=device)',
      '_ = torch.fft.rfft(x)',
      'print("ok")'
    ]
  })
}

export const probeXpuDemucsCompatibility = async (params: {
  pythonPath: string
  env: NodeJS.ProcessEnv
}) =>
  await probeTorchDeviceCompatibility({
    pythonPath: params.pythonPath,
    env: params.env,
    scriptLines: [
      'import torch',
      'xpu_api = getattr(torch, "xpu", None)',
      'assert xpu_api and xpu_api.is_available()',
      'x = torch.randn(2048, device="xpu")',
      '_ = torch.fft.rfft(x)',
      'print("ok")'
    ]
  })
