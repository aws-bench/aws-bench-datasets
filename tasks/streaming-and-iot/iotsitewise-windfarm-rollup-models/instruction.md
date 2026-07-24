Create two IoT SiteWise asset models in us-east-1 named exactly `WindTurbineModel` and `WindFarmModel`. The child has an `ActivePower` measurement (`DOUBLE`). The parent has a `TotalActivePower` measurement (`DOUBLE`), a `Turbines` hierarchy referencing the child, and a `FleetAverageActivePower` (`DOUBLE`) metric over a 5-minute tumbling window that averages the child's `ActivePower` across the hierarchy.

IMPORTANT: Write your final prose answer to `/logs/agent/agent-output.txt`.
