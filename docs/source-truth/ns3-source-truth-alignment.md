# DATASET Radio 2 source-truth alignment

Source file: `C:/Users/ramit/Downloads/DATASET Radio 2.pptx`
Extracted text: `docs/source-truth/DATASET-Radio-2-extracted.txt`

## Congestion definition used by the simulator

The deck frames congestion as a busy-hour capacity issue where PRB/load is beyond the nominal limit, user queueing appears, and user throughput drops. The explicit slide-2 thresholds are:

- Cell load: observed `> 90%`, target `< 80%`.
- Waiting users / queue: observed `> 4`, target `<= 1`.
- Average user throughput: observed `< 4 Mbps`, target `>= 10 Mbps`.

NetVision keeps the UI's broader operational congestion index, but simulation decisions should treat source-truth severe congestion as the condition above: high PRB pressure, low throughput, and active users/queue pressure during peak periods.

## Executable simulation actions

The executable action set is limited to actions that can be represented by the current local cell/neighborhood model:

| NetVision action id | Deck label | Deck effect | Deck recovery prior | V1 model treatment |
| --- | --- | --- | --- | --- |
| `tilt` | Tilt / Ajustement puissance | Better coverage / throughput improvement around 10-20% | 15% | Approximate antenna/coverage adjustment. Confidence stays low without real antenna metadata. |
| `redistribute` | Equilibrage / Rebalancing charge | Move users to neighbor cells | 40% | Offload a bounded user share to candidate neighbors with PRB headroom. |
| `neighbor_optimization` | Action sur secteurs voisins | Interference / PRB optimization on neighbors | 35% | Policy model for neighbor bias/reattachment/interference relief. |
| `add_carrier` | Ajout de bande / carrier | Additional 10 MHz carrier, capacity +50% | 50% | Capacity/bandwidth extension on the selected sector. |
| `add_sector` | Ajout secteur / antenne | Total capacity x1.5-x2, high queue recovery | 85% | Same-site sector split with geographic/load redistribution. |

## Planning-only action

The deck gives `Ajout site` a 90% recovery prior, but this remains planning-only in NetVision V1. A new site cannot be executed as a simulator action until we have reliable site-placement assumptions, geospatial constraints, and validation data. Recommendations may mention site planning as an advisory, but `/api/jobs` and `/api/simulate` must reject `add_site` and `new_site`.

## Calibration rule

The deck explains recovery as:

`estimated gain = current unserved loss * recovery rate`

NetVision should not blindly present the prior as truth. The ns-3 result keeps the deck prior as `recovery_rate`, then reports calibration/error fields comparing the baseline run to observed PRB, throughput, and CQI. Confidence stays `low` until thresholds and real calibration profiles are defined.

## V1 fidelity boundary

The current ns-3 runner is an `operations_v1` local what-if model: target cell, same-site sectors, inferred neighbors, synthetic UEs, and observed KPI anchoring. It is suitable for operator directionality and debug traces, not yet for site-specific RF truth. Full LTE/EPC packet-level calibration remains the next fidelity step.
