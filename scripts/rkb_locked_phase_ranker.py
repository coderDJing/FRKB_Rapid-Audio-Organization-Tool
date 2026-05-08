# Generated from current/blind train splits by rkb_phase_ranker_rising_edge_locked_replay.py.
# Do not tune these constants against sealed-eval outputs.

import math
from typing import Any

import numpy as np

from beat_this_grid_solver import moving_average
from rkb_beatgrid_candidate_lab import _sigmoid
from rkb_onset_foot_phase_diagnostic import _candidate_onset_features
from rkb_phase_ranker_diagnostic import _safe_float, _signal_profiles
from rkb_phase_ranker_rising_edge_diagnostic import (
    _candidate_rising_edge_features,
    _feature_vector_with_rising_edge,
)

LOCKED_RISING_EDGE_RANKER_VERSION = "rkb-phase-ranker-rising-edge-prod-locked-v1"
LOCKED_RISING_EDGE_RANK_LIMIT = 16
LOCKED_RISING_EDGE_THRESHOLD = 0.93
LOCKED_RISING_EDGE_L2 = 0.3
LOCKED_RISING_EDGE_REQUIRE_SAME_MOD4 = False
LOCKED_RISING_EDGE_TRAIN_EXAMPLES = 13776
LOCKED_RISING_EDGE_TRAIN_POSITIVE_COUNT = 2393
LOCKED_RISING_EDGE_BIAS = -0.81692214098182248

LOCKED_RISING_EDGE_FEATURE_NAMES = (
    'rank', 'invRank', 'candidateScore', 'selectedScore',
    'scoreMinusSelected', 'bpm', 'beatIntervalMs', 'bpmMinusSelected',
    'absBpmMinusSelected', 'beatIntervalMinusSelected', 'candidateToSelectedPhaseDeltaMs', 'candidateToSelectedPhaseAbsDeltaMs',
    'barBeatOffsetSameMod4', 'barBeatOffsetSameExact32', 'phaseWithinBeatSin', 'phaseWithinBeatCos',
    'barBeatOffset32Sin', 'barBeatOffset32Cos', 'barBeatOffset4Sin', 'barBeatOffset4Cos',
    'candidate.tempoScore', 'delta.tempoScore', 'candidate.tempoBaseScore', 'delta.tempoBaseScore',
    'candidate.tempoQuantizedScore', 'delta.tempoQuantizedScore', 'candidate.phaseScore', 'delta.phaseScore',
    'candidate.phaseSupportRatio', 'delta.phaseSupportRatio', 'candidate.phaseCompactness', 'delta.phaseCompactness',
    'candidate.phaseSupport', 'delta.phaseSupport', 'candidate.attackPhaseScore', 'delta.attackPhaseScore',
    'candidate.attackPhaseSupport', 'delta.attackPhaseSupport', 'candidate.leadingEdgeScore', 'delta.leadingEdgeScore',
    'candidate.leadingEdgeTargetScore', 'delta.leadingEdgeTargetScore', 'candidate.leadingEdgeConsistencyScore', 'delta.leadingEdgeConsistencyScore',
    'candidate.leadingEdgePeakScore', 'delta.leadingEdgePeakScore', 'candidate.leadingEdgeSupport', 'delta.leadingEdgeSupport',
    'candidate.leadingEdgePeakOffsetMadMs', 'delta.leadingEdgePeakOffsetMadMs', 'candidate.leadingEdgePeakOffsetMedianMs', 'delta.leadingEdgePeakOffsetMedianMs',
    'candidate.leadingEdgeTargetOffsetMs', 'delta.leadingEdgeTargetOffsetMs', 'candidate.introLeadingEdgeScore', 'delta.introLeadingEdgeScore',
    'candidate.introLeadingEdgeTargetScore', 'delta.introLeadingEdgeTargetScore', 'candidate.introLeadingEdgeConsistencyScore', 'delta.introLeadingEdgeConsistencyScore',
    'candidate.introLeadingEdgePeakScore', 'delta.introLeadingEdgePeakScore', 'candidate.introLeadingEdgeSupport', 'delta.introLeadingEdgeSupport',
    'candidate.introLeadingEdgePeakOffsetMadMs', 'delta.introLeadingEdgePeakOffsetMadMs', 'candidate.introLeadingEdgePeakOffsetMedianMs', 'delta.introLeadingEdgePeakOffsetMedianMs',
    'candidate.introLeadingEdgeTargetOffsetMs', 'delta.introLeadingEdgeTargetOffsetMs', 'candidate.dpBeatMean', 'delta.dpBeatMean',
    'candidate.dpBeatSegmentAgreement', 'delta.dpBeatSegmentAgreement', 'candidate.dpBeatSegmentMin', 'delta.dpBeatSegmentMin',
    'candidate.dpBeatSupport', 'delta.dpBeatSupport', 'candidate.dpFullAttackMean', 'delta.dpFullAttackMean',
    'candidate.dpFullAttackSegmentAgreement', 'delta.dpFullAttackSegmentAgreement', 'candidate.dpLowAttackMean', 'delta.dpLowAttackMean',
    'candidate.dpLowAttackSegmentAgreement', 'delta.dpLowAttackSegmentAgreement', 'candidate.phasePathScore', 'delta.phasePathScore',
    'candidate.phasePathTargetScore', 'delta.phasePathTargetScore', 'candidate.phasePathSegmentAgreement', 'delta.phasePathSegmentAgreement',
    'candidate.phasePathPeakScore', 'delta.phasePathPeakScore', 'candidate.phasePathIntroReliability', 'delta.phasePathIntroReliability',
    'candidate.phasePathStableSegmentCount', 'delta.phasePathStableSegmentCount', 'candidate.phasePathSupport', 'delta.phasePathSupport',
    'candidate.phasePathPeakOffsetMadMs', 'delta.phasePathPeakOffsetMadMs', 'candidate.phasePathPeakOffsetMedianMs', 'delta.phasePathPeakOffsetMedianMs',
    'candidate.phasePathTargetOffsetMs', 'delta.phasePathTargetOffsetMs', 'candidate.constantGridDpScore', 'delta.constantGridDpScore',
    'candidate.constantGridDpPhaseEvidenceSwitchScore', 'delta.constantGridDpPhaseEvidenceSwitchScore', 'candidate.constantGridDpPhaseEvidenceRank', 'delta.constantGridDpPhaseEvidenceRank',
    'candidate.downbeatScore', 'delta.downbeatScore', 'candidate.downbeatMargin', 'delta.downbeatMargin',
    'candidate.downbeatDeltaToBest', 'delta.downbeatDeltaToBest', 'candidate.downbeatRank', 'delta.downbeatRank',
    'candidate.downbeatSupport', 'delta.downbeatSupport', 'candidate.constantGridDpDownbeatAlternativePenalty', 'delta.constantGridDpDownbeatAlternativePenalty',
    'candidate.constantGridDpNegativeEdgeBonus', 'delta.constantGridDpNegativeEdgeBonus', 'candidate.constantGridDpOctavePenalty', 'delta.constantGridDpOctavePenalty',
    'candidate.phaseShiftMs', 'delta.phaseShiftMs', 'candidate.timelineQuantizationShiftMs', 'delta.timelineQuantizationShiftMs',
    'candidate.windowWeight', 'delta.windowWeight', 'candidate.onsetFootScore', 'delta.onsetFootScore',
    'candidate.onsetFootAgreementScore', 'delta.onsetFootAgreementScore', 'candidate.onsetFootSupport', 'delta.onsetFootSupport',
    'candidate.fullFootScore', 'delta.fullFootScore', 'candidate.fullFootTargetScore', 'delta.fullFootTargetScore',
    'candidate.fullFootConsistencyScore', 'delta.fullFootConsistencyScore', 'candidate.fullFootPeakDelayScore', 'delta.fullFootPeakDelayScore',
    'candidate.fullFootContrastScore', 'delta.fullFootContrastScore', 'candidate.fullFootSegmentAgreement', 'delta.fullFootSegmentAgreement',
    'candidate.fullFootFootOffsetMedianMs', 'delta.fullFootFootOffsetMedianMs', 'candidate.fullFootFootOffsetMadMs', 'delta.fullFootFootOffsetMadMs',
    'candidate.fullFootPeakOffsetMedianMs', 'delta.fullFootPeakOffsetMedianMs', 'candidate.fullFootRiseMsMedian', 'delta.fullFootRiseMsMedian',
    'candidate.fullFootSupport', 'delta.fullFootSupport', 'candidate.lowFootScore', 'delta.lowFootScore',
    'candidate.lowFootTargetScore', 'delta.lowFootTargetScore', 'candidate.lowFootConsistencyScore', 'delta.lowFootConsistencyScore',
    'candidate.lowFootPeakDelayScore', 'delta.lowFootPeakDelayScore', 'candidate.lowFootContrastScore', 'delta.lowFootContrastScore',
    'candidate.lowFootSegmentAgreement', 'delta.lowFootSegmentAgreement', 'candidate.lowFootFootOffsetMedianMs', 'delta.lowFootFootOffsetMedianMs',
    'candidate.lowFootFootOffsetMadMs', 'delta.lowFootFootOffsetMadMs', 'candidate.lowFootPeakOffsetMedianMs', 'delta.lowFootPeakOffsetMedianMs',
    'candidate.lowFootRiseMsMedian', 'delta.lowFootRiseMsMedian', 'candidate.lowFootSupport', 'delta.lowFootSupport',
    'candidateProfile.beatLogit.support', 'candidateProfile.beatLogit.blockCount', 'candidateProfile.beatLogit.medianOffsetMs', 'candidateProfile.beatLogit.offsetMadMs',
    'candidateProfile.beatLogit.segmentAgreement', 'candidateProfile.beatLogit.meanBestScore', 'candidateProfile.beatLogit.meanCenterScore', 'candidateProfile.beatLogit.meanMargin',
    'candidateProfile.beatLogit.absMedianOffsetMs', 'candidateProfile.beatLogit.positiveOffsetRatio', 'candidateProfile.beatLogit.negativeOffsetRatio', 'candidateProfile.beatLogit.zeroOffsetRatio',
    'candidateProfile.downbeatLogit.support', 'candidateProfile.downbeatLogit.blockCount', 'candidateProfile.downbeatLogit.medianOffsetMs', 'candidateProfile.downbeatLogit.offsetMadMs',
    'candidateProfile.downbeatLogit.segmentAgreement', 'candidateProfile.downbeatLogit.meanBestScore', 'candidateProfile.downbeatLogit.meanCenterScore', 'candidateProfile.downbeatLogit.meanMargin',
    'candidateProfile.downbeatLogit.absMedianOffsetMs', 'candidateProfile.downbeatLogit.positiveOffsetRatio', 'candidateProfile.downbeatLogit.negativeOffsetRatio', 'candidateProfile.downbeatLogit.zeroOffsetRatio',
    'candidateProfile.fullAttack.support', 'candidateProfile.fullAttack.blockCount', 'candidateProfile.fullAttack.medianOffsetMs', 'candidateProfile.fullAttack.offsetMadMs',
    'candidateProfile.fullAttack.segmentAgreement', 'candidateProfile.fullAttack.meanBestScore', 'candidateProfile.fullAttack.meanCenterScore', 'candidateProfile.fullAttack.meanMargin',
    'candidateProfile.fullAttack.absMedianOffsetMs', 'candidateProfile.fullAttack.positiveOffsetRatio', 'candidateProfile.fullAttack.negativeOffsetRatio', 'candidateProfile.fullAttack.zeroOffsetRatio',
    'candidateProfile.lowAttack.support', 'candidateProfile.lowAttack.blockCount', 'candidateProfile.lowAttack.medianOffsetMs', 'candidateProfile.lowAttack.offsetMadMs',
    'candidateProfile.lowAttack.segmentAgreement', 'candidateProfile.lowAttack.meanBestScore', 'candidateProfile.lowAttack.meanCenterScore', 'candidateProfile.lowAttack.meanMargin',
    'candidateProfile.lowAttack.absMedianOffsetMs', 'candidateProfile.lowAttack.positiveOffsetRatio', 'candidateProfile.lowAttack.negativeOffsetRatio', 'candidateProfile.lowAttack.zeroOffsetRatio',
    'profileDelta.beatLogit.support', 'profileDelta.beatLogit.blockCount', 'profileDelta.beatLogit.medianOffsetMs', 'profileDelta.beatLogit.offsetMadMs',
    'profileDelta.beatLogit.segmentAgreement', 'profileDelta.beatLogit.meanBestScore', 'profileDelta.beatLogit.meanCenterScore', 'profileDelta.beatLogit.meanMargin',
    'profileDelta.downbeatLogit.support', 'profileDelta.downbeatLogit.blockCount', 'profileDelta.downbeatLogit.medianOffsetMs', 'profileDelta.downbeatLogit.offsetMadMs',
    'profileDelta.downbeatLogit.segmentAgreement', 'profileDelta.downbeatLogit.meanBestScore', 'profileDelta.downbeatLogit.meanCenterScore', 'profileDelta.downbeatLogit.meanMargin',
    'profileDelta.fullAttack.support', 'profileDelta.fullAttack.blockCount', 'profileDelta.fullAttack.medianOffsetMs', 'profileDelta.fullAttack.offsetMadMs',
    'profileDelta.fullAttack.segmentAgreement', 'profileDelta.fullAttack.meanBestScore', 'profileDelta.fullAttack.meanCenterScore', 'profileDelta.fullAttack.meanMargin',
    'profileDelta.lowAttack.support', 'profileDelta.lowAttack.blockCount', 'profileDelta.lowAttack.medianOffsetMs', 'profileDelta.lowAttack.offsetMadMs',
    'profileDelta.lowAttack.segmentAgreement', 'profileDelta.lowAttack.meanBestScore', 'profileDelta.lowAttack.meanCenterScore', 'profileDelta.lowAttack.meanMargin',
    'candidate.risingEdgeScore', 'delta.risingEdgeScore', 'candidate.risingEdgeAgreementScore', 'delta.risingEdgeAgreementScore',
    'candidate.fullRiseScore', 'delta.fullRiseScore', 'candidate.fullRiseTarget0Score', 'delta.fullRiseTarget0Score',
    'candidate.fullRiseTargetPos8Score', 'delta.fullRiseTargetPos8Score', 'candidate.fullRiseTargetNeg8Score', 'delta.fullRiseTargetNeg8Score',
    'candidate.fullRiseConsistencyScore', 'delta.fullRiseConsistencyScore', 'candidate.fullRisePeakOffsetMedianMs', 'delta.fullRisePeakOffsetMedianMs',
    'candidate.fullRisePeakOffsetMadMs', 'delta.fullRisePeakOffsetMadMs', 'candidate.fullRisePeakAmplitudeMean', 'delta.fullRisePeakAmplitudeMean',
    'candidate.fullRiseSupport', 'delta.fullRiseSupport', 'candidate.lowRiseScore', 'delta.lowRiseScore',
    'candidate.lowRiseTarget0Score', 'delta.lowRiseTarget0Score', 'candidate.lowRiseTargetPos8Score', 'delta.lowRiseTargetPos8Score',
    'candidate.lowRiseTargetNeg8Score', 'delta.lowRiseTargetNeg8Score', 'candidate.lowRiseConsistencyScore', 'delta.lowRiseConsistencyScore',
    'candidate.lowRisePeakOffsetMedianMs', 'delta.lowRisePeakOffsetMedianMs', 'candidate.lowRisePeakOffsetMadMs', 'delta.lowRisePeakOffsetMadMs',
    'candidate.lowRisePeakAmplitudeMean', 'delta.lowRisePeakAmplitudeMean', 'candidate.lowRiseSupport', 'delta.lowRiseSupport',
)

LOCKED_RISING_EDGE_MEAN = (
    8.5, 0.21129556207680492, 0.81041661236934093, 2.2066690696864213, -1.3962524573170714, 125.91309451219479,
    489.44878707500817, -6.0646444889663176, 6.1751017549361213, 31.074333183964718, 3.5451662801941319, 23.758784453052339,
    0.56525842044134722, 0.52373693379790942, 0.31637860765743653, 0.48372101300418069, 0.12605090580385953, 0.9723808297570532,
    0.024390243902439025, 0.49303135888501742, 0.97737777562424755, 0.34779024136178838, 0.86265572103658505, 0.83658633776131786,
    0.884201509872242, 0.85762775842044148, 0.78682254507839966, -0.10967323192508711, 0.82493720463124331, 0.79954952054297668,
    0.69817184959349221, 0.6790202979094071, 202.55770905923345, 196.6506242740999, 0.090438772212543858, 0.088757242595819116,
    251.81787166085945, 245.10126306620208, 0.79526191710222915, 0.77009433986645004, 0.68525424651567945, 0.65982959494773519,
    0.8732993958333114, 0.84845286853947133, 0.94121128789199016, 0.91612280240999211, 131.83427700348432, 128.4753919860627,
    1.7798344947735192, 1.7537020905923344, 7.4677700348432055, 7.2572590011614402, 9.3249128919860631, 9.0972706155632981,
    0.68280038218645911, 0.6628682881098017, 0.49015271123693382, 0.47318479602206737, 0.85831990331006447, 0.83608661759578151,
    0.91184486396631392, 0.88753974898373578, 32, 31.145180023228804, 2.0236643437862951, 1.9597851335656213,
    7.935866724738676, 7.7230328106852495, 0, 0, 0.74012064815621592, 0.7250149431620222,
    0.75140274237804716, 0.73089983297038086, 0.55056606424215837, 0.53984925239546933, 251.82665505226481, 245.11004645760744,
    0.0941082081881537, 0.092410025842044385, 0.61145089409117448, 0.59137389989837574, 0.089963319468641348, 0.088376545949477622,
    0.5970498894454106, 0.57871174426538763, 0.77484817675667239, 0.7509981395905897, 0.62567145760743326, 0.60200711382113825,
    0.96340011614401577, 0.93715156794424836, 0.86831214939024459, 0.84532763603368288, 0.75086614104244609, 0.72916332919575555,
    2.8664343786295006, 2.7781649245063877, 64, 62.290360046457607, 0.37238675958188155, 0.36774099883855982,
    6.6914924506387923, 6.4824332171893149, 9.2465156794425081, 9.0049361207897789, 0.81041661236934093, 0.78539447183507771,
    0.70023570993031281, -0.13717403803716621, 8.5, 6.5569105691056908, 0.62895844396051181, 0.391417698315911,
    0.35494195993031374, 0.3445167613240413, 0.10803310990127758, 0.10803310990127758, 0.37630662020905925, 0.37630662020905925,
    63.041158536585364, 61.360554587688732, 0.013489949404762218, 0.013489949404762218, 0.01625834785133775, 0.014789126016262066,
    0, 0, -3.3094888211382143, -2.9880602497096436, 0.0022052845528452592, 0.0026675377468058409,
    0.86430345884145521, 0.83821070622821381, 0.55058929638501941, -0.051740740781068564, 0.66690712108013939, 0.017407992160278746,
    124.99078106852497, 0.21145470383275261, 0.53207300232287402, -0.076196529616724185, 0.26369229094076657, -0.15762013646922182,
    0.82282592915214869, 0.017512340301974447, 0.59165807701802109, -0.073530371297909083, 0.44477769686411156, -0.0824067828106851,
    0.86353077816491874, 0.011498257839721275, -7.8006678281068522, -7.2803426248548195, 3.3125, -3.1288472706155632,
    12.032302555168409, -5.9549216027874561, 21.244120209059233, -1.5143002322880372, 62.849883855981417, 0.12746806039488967,
    0.55004756119338194, -0.02228463276713127, 0.2760121769744483, -0.032313897357723574, 0.79817935177119625, 0.014279816347270616,
    0.6252763338414391, -0.067879112151567944, 0.56624118691927994, -0.033723291594076769, 0.85606761759581884, 0.014749382984901277,
    -5.9593495934959346, -6.826364692218351, 3.3294497677119628, -2.2071355981416958, 14.668644744483158, -5.8688117015098724,
    21.694087543554009, -0.89243975029036005, 62.140897212543557, 0.083986643437862954, 64, 4,
    -7.670150987224158, 0.073170731707317069, 0.99477351916376311, 0.92204505081301202, 0.82342053353658284, 0.098624519381533368,
    12.440185830429733, 0.01326809306039489, 0.049231906939605108, 0, 64, 4,
    -8.2382404181184672, 0.08434959349593496, 0.99397502903600465, 0.30648387935540078, 0.26894873758710797, 0.037535141768292618,
    12.691202090592334, 0.012612514518002323, 0.04988748548199768, 0, 64, 4,
    3.5111788617886179, 0.38138792102206737, 0.9694395948025516, 0.29728837478222875, 0.11871228121370599, 0.17857609698025523,
    9.5056620209059233, 0.040641332752613238, 0.018550150624274099, 0.0033085166231126596, 64, 4,
    6.303716608594657, 0.44076655052264807, 0.96545923787747123, 0.24913270550232328, 0.10533057367886157, 0.14380212862950056,
    10.950348432055749, 0.045284825058072006, 0.014051838342044135, 0.0031633365998838558, 0, 0,
    -4.5203252032520327, 0.008130081300813009, -0.00058072009291521487, 0.0098915920441347144, 0.038350373257839791, -0.028458747749709738,
    0, 0, -4.1941056910569108, 0.0030487804878048782, -0.00021777003484320557, 0.010293921167247347,
    0.01072672364982577, -0.0004327931910569391, 0, 0, -3.6827816492450638, -0.0018873403019744484,
    -0.0011372460801393795, 0.0045332772212543539, 0.058351537891986237, -0.053818249128919866, 0, 0,
    -3.5522648083623691, -0.037746806039488968, 0.0030124794570267175, 0.0051445127032520178, 0.058668839648664331, -0.053524337108013714,
    0.51140944163762414, 0.51140944163762414, 0.64444504936120794, 0.64444504936120794, 0.49339302794712742, 0.49339302794712742,
    0.30620644599303221, 0.30620644599303221, 0.28672449905632968, 0.28672449905632968, 0.22074622633565627, 0.22074622633565627,
    0.77714265200349031, 0.77714265200349031, 3.7993612078977934, 3.7993612078977934, 3.4766260162601625, 3.4766260162601625,
    0.014496432347415671, 0.014496432347415671, 63.972270615563296, 63.972270615563296, 0.49297060685248661, 0.49297060685248661,
    0.29139445412311266, 0.29139445412311266, 0.31512230712833805, 0.31512230712833805, 0.19092078919860769, 0.19092078919860769,
    0.73599611004644572, 0.73599611004644572, 6.6548707897793262, 6.6548707897793262, 4.0959821428571432, 4.0959821428571432,
    0.048466571286658267, 0.048466571286658267, 63.975246806039486, 63.975246806039486,
)

LOCKED_RISING_EDGE_STD = (
    4.6097722286464435, 0.23318628558935239, 0.080174662388652618, 0.21631807149104235, 0.23242464261479609, 17.434965658418001,
    96.524172598133219, 22.173222820943408, 22.142715311385619, 107.54353591188351, 69.105827206539686, 64.990027844026045,
    0.49572304622797037, 0.49943624014876403, 0.45855347431082011, 0.67501649564468125, 0.19009040707799704, 0.049520987508670331,
    0.42564128686583047, 0.75838953715980773, 0.022078770642409033, 0.32306314691203608, 0.30957543976275265, 0.33968295051383324,
    0.31664784045393896, 0.34770285599974032, 0.10560597325418486, 0.18901829048461422, 0.19904659872931235, 0.24145292146350469,
    0.1203658267355962, 0.1620882586834306, 59.06526791675379, 67.593113098482348, 0.082788791924696487, 0.083191912173385368,
    34.8709105645421, 53.772151080779828, 0.17586706622075077, 0.23294340078486325, 0.35185081159027398, 0.38713999127040338,
    0.17712725986948477, 0.22636078946425015, 0.11863130150252935, 0.19089862145626654, 11.026676337720241, 23.93172825857252,
    2.5144524619506354, 2.5198012452237046, 9.2675822082463508, 9.4363869000759202, 1.7263771854298771, 2.2538787282498185,
    0.19354616062380234, 0.22983330261299309, 0.3553668145632034, 0.37183808355048859, 0.25026062875173111, 0.28341465857907733,
    0.21820487278477227, 0.26104316703300251, 1, 5.1597986456833072, 3.6598500055730425, 3.6307847728131097,
    11.613011277941196, 11.68065099024172, 1, 1, 0.18966031657923652, 0.21518457133099986,
    0.20104934914333983, 0.22994477462898441, 0.26573942838890152, 0.27407273810707855, 34.870698245495788, 53.773110506894071,
    0.086771062204406002, 0.087192505212241506, 0.21046239576760817, 0.24059046428534223, 0.076460467335094873, 0.076715078753803609,
    0.220467758693803, 0.24422428950978228, 0.19854149206776583, 0.24605027734803173, 0.37686696881241682, 0.40458383675060594,
    0.13081601375254243, 0.20544734404100284, 0.22117883579058417, 0.25835013973036697, 0.21000149073774541, 0.24908024328076606,
    1.5853623969876587, 1.6710469155408247, 1, 10.319597291366614, 1.3652623710139453, 1.3586365057487622,
    10.766530530032441, 10.838609059481302, 1.7164494344150656, 2.2465560225014385, 0.080174662388652618, 0.16523653828289636,
    0.11391242679827003, 0.10279742439302213, 4.6097722286464435, 5.0099159956553407, 0.3152752892882818, 0.38722777506224693,
    0.54753532697240748, 0.55070841003619497, 0.25517352332785337, 0.25517352332785337, 0.77859850194976443, 0.77859850194976443,
    8.7346084269459965, 13.463801981755834, 0.02806689735346439, 0.02806689735346439, 0.0314499255634096, 0.032296403302991862,
    1, 1, 8.018993633078459, 8.1520868413677885, 0.28287131783153346, 0.28368307554244793,
    0.30989303614542912, 0.34009691259982971, 0.18454954389938885, 0.19880295600384046, 0.33548866680513267, 0.27527796409641386,
    9.4396880869315023, 10.655283352919227, 0.20193068258003025, 0.23870454177020597, 0.34204768455873491, 0.46208463402204814,
    0.27527239262352643, 0.22533590520135888, 0.27664736200209261, 0.35984172386781837, 0.34375835875754845, 0.31685241459175534,
    0.2688870066395469, 0.25058999428359713, 43.550680552173688, 71.991611996064947, 41.691653095393747, 70.086773357448607,
    42.556492672961468, 70.429077866810843, 43.564258964180318, 70.001154784970083, 4.565511967122081, 5.8102881819831129,
    0.21139766056700682, 0.22895214820907159, 0.33850620609638049, 0.42375270333263976, 0.27847409993769745, 0.23327091769688346,
    0.29965780739451769, 0.36967480369087602, 0.37463105682438058, 0.31914834473697234, 0.27006284747115927, 0.23849861363244965,
    40.929689499059442, 63.467843007219081, 39.019279089908558, 61.959447155923137, 39.991740907103583, 62.239227962328357,
    40.943600261351044, 62.05414771084812, 5.7138852116949872, 5.9142256713233694, 1, 1,
    10.925432129878317, 1.0094732725160178, 0.072105233751145331, 0.15651837716037803, 0.24186504803653514, 0.19170924564408703,
    4.8412870082013919, 0.022560817733626538, 0.022560817733626538, 1, 1, 1,
    10.916927416674961, 1.0834110277360118, 0.077386501981142955, 0.10937016077845463, 0.11926145680868881, 0.07897610388401162,
    5.0971853903316022, 0.02159572479817249, 0.021595724798172494, 1, 1, 1,
    10.749362804412161, 1.6487463091420262, 0.12617069273186055, 0.1519886331889288, 0.1218850452313792, 0.15006104269374085,
    6.1253218074364302, 0.027081408892760381, 0.025848194166049384, 0.01207356095677802, 1, 1,
    11.08079703098468, 1.8564102753503104, 0.1368460757582029, 0.12711203026126716, 0.10466351669804858, 0.12206050128769919,
    6.5276929416080991, 0.025136709604970057, 0.023339507928020954, 0.011689493785505472, 1, 1,
    14.197192403282473, 1.3703950825459634, 0.097885363039002277, 0.11007312362678484, 0.26998150609014226, 0.24887704371737868,
    1, 1, 13.92160354975268, 1.446186059803926, 0.10329900427170896, 0.077176364423034854,
    0.11852912749558012, 0.095249936023502943, 1, 1, 12.3458490222927, 1.8353373904821417,
    0.12474454099990021, 0.047390532430885181, 0.13159791752780173, 0.13753146336326316, 1, 1,
    12.785503645351577, 1.8869849571670463, 0.13061263986163088, 0.041897797301469447, 0.11446620995299724, 0.11928994104925665,
    0.17684094449039464, 0.17684094449039464, 0.38066145368790044, 0.38066145368790044, 0.19766793347474959, 0.19766793347474959,
    0.34146930812375859, 0.34146930812375859, 0.33995904583678721, 0.33995904583678721, 0.30728924841215605, 0.30728924841215605,
    0.3437927527340689, 0.3437927527340689, 18.092703582850465, 18.092703582850465, 6.3588744355127691, 6.3588744355127691,
    0.0057240839548014328, 0.0057240839548014328, 0.21408845997670206, 0.21408845997670206, 0.20138519510691, 0.20138519510691,
    0.33477735773067918, 0.33477735773067918, 0.35336654365532061, 0.35336654365532061, 0.29394492402065275, 0.29394492402065275,
    0.33932351133748029, 0.33932351133748029, 18.818842517769973, 18.818842517769973, 6.590427620117028, 6.590427620117028,
    0.019617214390714514, 0.019617214390714514, 0.20422354457784556, 0.20422354457784556,
)

LOCKED_RISING_EDGE_WEIGHTS = (
    -0.010824445470448519, 0.025057928810031601, 0.039075018323740267, -0.0056583828465821039, 0.018741606513367311, 0.048056501273759343,
    -0.055123292213984355, 0.045634682948984387, -0.046608457209398449, -0.055142431834038906, 0.0026967917017634633, -0.054254233014191869,
    0.14630463358910045, 0.11286912072314662, 0.0013566511471714124, -0.0089277249591838814, -0.11445297756480249, 0.073962336588863947,
    -0.071117217782791287, 0.15389437622928967, 0.025220473464659748, -0.01143996511494238, 0.021538786604010148, 0.016769200473736749,
    0.026378569111692743, 0.02119905055510651, 0.0073604946253562221, 0.0096028407382450429, 0.015849879297324267, 0.0083206606028397422,
    -6.0517557413924836e-05, -0.0040005814341928072, 0.0059963140189804266, 0.002460961421437472, -0.010217532251077117, -0.0097474758199814094,
    0.048110164759812397, 0.026182393508862777, 0.0016368227850789355, -0.0027115876789339604, -0.0071505185388009672, -0.0090042179274078017,
    0.022392497543785316, 0.013022751053967588, 0.0068122332540606475, 0.0011108621600425526, -0.017027453370648035, -0.013489629768883772,
    -0.022330225269735066, -0.02243022719181249, 0.023218676816681681, 0.021715405359732425, -0.015187751016397908, -0.016945111636541995,
    0.019524491357442771, 0.011315845639969053, 0.024894032247559518, 0.018751951025214007, 0.0023299832087635749, 0.00075997881913918012,
    -0.024174566837986577, -0.022989265517542337, 0, -0.0064956145854031732, -0.00213202571182895, -0.0049178008157986603,
    -0.012940533524731927, -0.010799473184879699, 0, 0, -0.0094035725069261007, -0.0090813336088807241,
    -0.018134001948939688, -0.017661097790091101, -0.017773659523517608, -0.016578159015558733, 0.048059430032909814, 0.02614883905740506,
    -0.010987340442588554, -0.010506680562869289, 0.012244080940313052, 0.0066557647148506819, -0.10097933596255732, -0.10049410008921726,
    -0.02800586345777676, -0.028224124732442388, 0.012137535290669384, 0.0058646477951328022, 0.0096037505687326229, 0.00516737891600911,
    0.0074354790411673456, 0.00048375939632872922, -0.010924721563739198, -0.011608103862630323, 0.036974704195829024, 0.028317140904183431,
    0.016063952787514078, 0.015243196716083792, 0, -0.0064956145854031732, -0.007759676894986565, -0.0091720128445270735,
    0.020020171052933244, 0.019774730588122801, 0.015740061370654493, 0.0075874075005359512, 0.039075018323740267, 0.013429914311896229,
    0.047177428869436044, 0.049537453722385355, -0.010824445470448519, 0.0066381381109288252, 0.03138882473466089, 0.023400739027693192,
    0.037047502114237733, 0.036129327126689988, -0.051204209499588198, -0.051204209499588198, -0.057881680352563969, -0.057881680352563969,
    0.050527613404148859, 0.027763561315574052, -0.058039852078671329, -0.058039852078671329, 0.011461224725243005, 0.0093800348080990761,
    0, 0, -0.019942246443368547, -0.017204762015601519, 0.019461807586640963, 0.018282141788714963,
    0.021605901399244246, 0.016806249136594335, 0.056046507785035969, 0.030551222834880033, -0.011680748446831658, -0.0055216807748174794,
    -0.018256874459256889, -0.011564625471592984, 0.080096827052059727, 0.044026126051709455, 0.12010733610322938, 0.061170214721907791,
    -0.00056198258251338783, -0.0016476822273462091, -0.0053712383597938704, -0.016772501141159836, 0.037367516445692452, 0.039170052052527181,
    -0.026243456515355125, -0.026617452918216853, 0.019602745358820135, 0.0030284864719894292, 0.011691847455294686, -0.0067621714002444626,
    0.011557195706592525, -0.0015169467200341193, 0.0037553137753884658, -0.011157856384885961, -0.025027898129713778, -0.011067201864675469,
    0.011935382349288849, -0.0045248028636260349, 0.03208933376723578, -8.6165330783105333e-05, -0.013029013479460737, 0.0054821086650093812,
    0.019415587788247247, -0.0036971366745277992, -0.017995006296778183, -0.0083913959763453009, -0.031767309421606084, -0.033103063657012627,
    0.014563684015805569, 0.01828811569538244, 0.0038617703699597937, 0.0024332519873365714, 0.016431065277166, 0.012092440728603897,
    0.0038763914643159115, -0.0052313631749724776, -0.0037164799755459027, -0.011254124764570592, 0, 0,
    0.038754309006019241, 0.0068126597777169486, -0.0068126597777169772, -0.0080543898072801753, 0.026562592022657375, -0.040084423063662673,
    -0.079022087148397341, 0.018072027093545048, -0.018072027093545065, 0, 0, 0,
    0.035725804867762473, 0.0012459177098802304, -0.0012459177098802516, 0.019154706595021685, 0.058861504101288729, -0.062359942874146861,
    -0.084949156614659696, 0.010603803468921442, -0.010603803468921438, 0, 0, 0,
    0.023845799646281085, -0.016303826283964182, 0.016428407702740129, 0.00080982047650042944, -0.00070801665838441253, 0.0013928760435737608,
    -0.00045500010445343711, 0.081112270733435021, -0.074596048383517757, -0.022227378747798468, 0, 0,
    0.015232353010191296, -0.0054271109855094039, 0.006758444100491064, -0.019111245420187203, -0.092634676847173733, 0.059534762029499914,
    0.061711310534045549, 0.022023886395829424, -0.007468538534975153, -0.032441946384730649, 0, 0,
    0.043690163195582436, 0.013637442690760494, -0.013637442690760509, 0.0036002643063929303, -0.0058177629564371645, 0.0080262334636792589,
    0, 0, 0.036888135480863379, -0.0016250705530825294, 0.0016250705530825224, -0.0053731727701573527,
    0.018182544567439417, -0.027021844934726588, 0, 0, 0.025397980899346678, -0.016855282474765837,
    0.013467807793087113, -0.0055309046395036815, -7.474748665990856e-05, -0.0016850352163989551, 0, 0,
    0.029242635683989, 0.0016963207516377584, 0.00054879760880851972, -0.010272008782307, -0.076285151523846628, 0.069572846006395142,
    0.0073659480820971084, 0.0073659480820971084, 0.023010736782103875, 0.023010736782103875, 0.00043805822457666847, 0.00043805822457666847,
    0.061086687170650272, 0.061086687170650272, -0.022421450047112497, -0.022421450047112497, -0.0053949709202242039, -0.0053949709202242039,
    -0.0098983240932605434, -0.0098983240932605434, 0.013741300520359391, 0.013741300520359391, 0.0037862942818177592, 0.0037862942818177592,
    0.020516345207511617, 0.020516345207511617, -0.012458890479301652, -0.012458890479301652, 0.0037616291913147161, 0.0037616291913147161,
    -0.0097320054206546536, -0.0097320054206546536, 0.013231682933067304, 0.013231682933067304, -0.010898343270858467, -0.010898343270858467,
    -0.0056369467905552492, -0.0056369467905552492, -0.023099808796150111, -0.023099808796150111, 0.010741862515830869, 0.010741862515830869,
    0.005841493362930595, 0.005841493362930595, -0.013247653728656144, -0.013247653728656144,
)


def _candidate_source(candidate: dict[str, Any]) -> str:
    tempo_source = str(candidate.get("tempoSource") or "tempo")
    phase_source = str(candidate.get("phaseSource") or "phase")
    bar_source = str(candidate.get("barSource") or "bar")
    return f"constant-grid-dp:{tempo_source}:{phase_source}:{bar_source}"


def _signal_bundle_from_arrays(arrays: dict[str, Any]) -> dict[str, tuple[np.ndarray, float]]:
    beat_logits = _sigmoid(np.asarray(arrays["beatLogits"], dtype="float64"))
    downbeat_logits = _sigmoid(np.asarray(arrays["downbeatLogits"], dtype="float64"))
    full_attack = np.asarray(arrays["fullAttackEnvelope"], dtype="float64")
    low_attack = np.asarray(arrays["lowrateAttackEnvelope"], dtype="float64")
    beat_rate = float(np.asarray(arrays["beatLogitFrameRate"]).item())
    downbeat_rate = float(np.asarray(arrays["downbeatLogitFrameRate"]).item())
    full_rate = float(np.asarray(arrays["fullAttackSampleRate"]).item())
    low_rate = float(np.asarray(arrays["lowrateAttackSampleRate"]).item())
    full_window = max(1, int(round(full_rate * 0.008)))
    low_window = max(1, int(round(low_rate * 0.012)))
    return {
        "beatLogit": (beat_logits, beat_rate),
        "downbeatLogit": (downbeat_logits, downbeat_rate),
        "fullAttack": (moving_average(full_attack, full_window), full_rate),
        "lowAttack": (moving_average(low_attack, low_window), low_rate),
    }


def _selected_profile(
    *,
    selected: dict[str, Any],
    selected_source: str,
    signal_bundle: dict[str, tuple[np.ndarray, float]],
    duration_sec: float,
) -> dict[str, Any]:
    candidate_like = {
        "bpm": _safe_float(selected.get("bpm")),
        "firstBeatMs": _safe_float(selected.get("firstBeatMs")),
    }
    onset_features = _candidate_onset_features(
        candidate=candidate_like,
        signal_bundle=signal_bundle,
        duration_sec=duration_sec,
    )
    return {
        "score": _safe_float(selected.get("score")),
        "source": selected_source,
        "bpm": _safe_float(selected.get("bpm")),
        "firstBeatMs": _safe_float(selected.get("firstBeatMs")),
        "timelineFirstBeatMs": _safe_float(selected.get("firstBeatMs")),
        "barBeatOffset": int(selected.get("barBeatOffset") or 0) % 32,
        "features": {**dict(selected.get("features") or {}), **onset_features},
        "profiles": _signal_profiles(
            candidate=candidate_like,
            signal_bundle=signal_bundle,
            duration_sec=duration_sec,
        ),
    }


def _candidate_profile(
    *,
    candidate: dict[str, Any],
    rank: int,
    selected: dict[str, Any],
    signal_bundle: dict[str, tuple[np.ndarray, float]],
    duration_sec: float,
) -> tuple[list[float], list[str], dict[str, Any]]:
    candidate_features = dict(candidate.get("features") or {})
    candidate_like = {
        **candidate,
        "rank": int(rank),
        "source": _candidate_source(candidate),
        "score": _safe_float(candidate.get("score")),
        "bpm": _safe_float(candidate.get("bpm")),
        "firstBeatMs": _safe_float(candidate.get("firstBeatMs")),
        "timelineFirstBeatMs": _safe_float(candidate.get("firstBeatMs")),
        "barBeatOffset": int(candidate.get("barBeatOffset") or 0) % 32,
        "features": {
            **candidate_features,
            **_candidate_onset_features(
                candidate=candidate,
                signal_bundle=signal_bundle,
                duration_sec=duration_sec,
            ),
            **_candidate_rising_edge_features(
                candidate=candidate,
                signal_bundle=signal_bundle,
                duration_sec=duration_sec,
            ),
        },
    }
    profiles = _signal_profiles(
        candidate=candidate_like,
        signal_bundle=signal_bundle,
        duration_sec=duration_sec,
    )
    values, names = _feature_vector_with_rising_edge(
        candidate=candidate_like,
        selected=selected,
        candidate_profiles=profiles,
    )
    return values, names, candidate_like


def _predict_probability(values: list[float]) -> float:
    total = LOCKED_RISING_EDGE_BIAS
    for value, mean, std, weight in zip(
        values,
        LOCKED_RISING_EDGE_MEAN,
        LOCKED_RISING_EDGE_STD,
        LOCKED_RISING_EDGE_WEIGHTS,
        strict=False,
    ):
        safe_std = std if abs(float(std)) >= 1e-6 else 1.0
        standardized = (float(value) - float(mean)) / safe_std
        standardized = max(-8.0, min(8.0, standardized))
        total += standardized * float(weight)
    return 1.0 / (1.0 + math.exp(-max(-40.0, min(40.0, total))))


def choose_locked_rising_edge_candidate(
    *,
    candidates: list[dict[str, Any]],
    selected: dict[str, Any],
    selected_source: str,
    arrays: dict[str, Any],
    duration_sec: float,
) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    if "legacy" not in selected_source.lower():
        return None, {"enabled": True, "reason": "selected-source-not-legacy"}
    if not candidates:
        return None, {"enabled": True, "reason": "no-candidates"}

    signal_bundle = _signal_bundle_from_arrays(arrays)
    selected_profile = _selected_profile(
        selected=selected,
        selected_source=selected_source,
        signal_bundle=signal_bundle,
        duration_sec=duration_sec,
    )
    best: dict[str, Any] | None = None
    best_meta: dict[str, Any] = {"probability": 0.0}
    scored_count = 0
    for rank, candidate in enumerate(candidates[:LOCKED_RISING_EDGE_RANK_LIMIT], start=1):
        values, names, candidate_like = _candidate_profile(
            candidate=candidate,
            rank=rank,
            selected=selected_profile,
            signal_bundle=signal_bundle,
            duration_sec=duration_sec,
        )
        if tuple(names) != LOCKED_RISING_EDGE_FEATURE_NAMES:
            return None, {
                "enabled": True,
                "reason": "feature-name-mismatch",
                "expectedFeatureCount": len(LOCKED_RISING_EDGE_FEATURE_NAMES),
                "actualFeatureCount": len(names),
            }
        probability = round(_predict_probability(values), 9)
        features = candidate.get("features") if isinstance(candidate.get("features"), dict) else {}
        features["lockedRisingEdgeRankerProbability"] = probability
        candidate["features"] = features
        scored_count += 1
        if probability > float(best_meta.get("probability") or 0.0):
            best = candidate
            best_meta = {
                "probability": probability,
                "candidateRank": rank,
                "candidateSource": str(candidate_like.get("source") or ""),
                "threshold": LOCKED_RISING_EDGE_THRESHOLD,
            }

    if best is None or float(best_meta["probability"]) < LOCKED_RISING_EDGE_THRESHOLD:
        return None, {
            "enabled": True,
            "reason": "below-threshold",
            "scoredCandidateCount": scored_count,
            **best_meta,
        }
    return best, {
        "enabled": True,
        "reason": "selected",
        "scoredCandidateCount": scored_count,
        "version": LOCKED_RISING_EDGE_RANKER_VERSION,
        "l2": LOCKED_RISING_EDGE_L2,
        "rankLimit": LOCKED_RISING_EDGE_RANK_LIMIT,
        "requireSameMod4": LOCKED_RISING_EDGE_REQUIRE_SAME_MOD4,
        "trainExamples": LOCKED_RISING_EDGE_TRAIN_EXAMPLES,
        "trainPositiveCount": LOCKED_RISING_EDGE_TRAIN_POSITIVE_COUNT,
        **best_meta,
    }
