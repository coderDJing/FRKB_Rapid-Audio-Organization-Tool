export const hasCurrentKeyAnalysisJobOwnership = <T extends { jobId: number }>(
  job: T,
  state: {
    terminationExpected: boolean
    busyJobId?: number
    inFlightJob?: T
    activeJob?: T
  }
) =>
  !state.terminationExpected &&
  state.busyJobId === job.jobId &&
  state.inFlightJob === job &&
  state.activeJob === job
