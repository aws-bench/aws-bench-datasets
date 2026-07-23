# /// script
# dependencies = []
# ///

import argparse
import json
from pathlib import Path


def main(input_path: Path, output_path: Path) -> None:
    rewards: list[float] = []
    for line in input_path.read_text().splitlines():
        reward = json.loads(line)
        if reward is None:
            rewards.append(0.0)
        elif len(reward) != 1:
            raise ValueError(f"Expected one key in reward dict, got {len(reward)}")
        else:
            rewards.extend(float(v) for v in reward.values())

    n = len(rewards)
    n_passed = sum(1 for r in rewards if r >= 1.0)
    output_path.write_text(
        json.dumps(
            {
                "pass_rate": n_passed / n if n else 0.0,
                "mean": sum(rewards) / n if n else 0.0,
                "n_tasks": n,
                "n_passed": n_passed,
            }
        )
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("-i", "--input-path", type=Path, required=True)
    parser.add_argument("-o", "--output-path", type=Path, required=True)
    args = parser.parse_args()
    main(args.input_path, args.output_path)
