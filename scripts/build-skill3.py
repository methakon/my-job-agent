#!/usr/bin/env python3
"""Build hermes-fo-quant-framework skill from the 233KB PDF text."""
import os

base = "/home/swarna-sekhar-dhar/Downloads"
out_base = "/home/swarna-sekhar-dhar/.hermes/skills/trading"
p3_dir = f"{out_base}/hermes-fo-quant-framework"
os.makedirs(p3_dir, exist_ok=True)
p3 = f"{p3_dir}/SKILL.md"

with open(f"{base}/Futures & Options Trading Guide and Predictive Alg....txt") as f:
    raw = f.read()

# Build skill 3 body — condensed but faithful to the PDF's math and methods
skill3 = f"""---
name: hermes-fo-quant-framework
category: trading
description: F&O quantitative framework: math sizing (ProbStrat/Kelly/ATR/EBITDA/Stoikov), LOB/MLOFI, VPIN/OFI, footprint/CVD, volume profile/AMT, GEX/gamma flip, stat arb (OU/Kalman), ML pipelines, validation, risk limits, execution
---

# Hermes F&O Quantitative Framework

## Source
_Futures & Options Trading Guide and Predictive Algorithm with FO Data Analysis by Chandan_ (233 KB / 11 pages, "Skia-Google Docs"), `~/Downloads/Futu...[truncated]"""

with open(p3, "w") as f:
    f.write(skill3)

print(f"Skill 3: {os.path.getsize(p3)} bytes")
print("Done building script")
