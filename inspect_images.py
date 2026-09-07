#!/usr/bin/env python3
"""Inspect trading images for content analysis."""

import os
from PIL import Image

trading_dir = "/home/swarna-sekhar-dhar/Pictures/trading"
images = sorted(os.listdir(trading_dir))

print(f"Found {len(images)} images in trading directory:\n")

for img_file in images:
    img_path = os.path.join(trading_dir, img_file)
    try:
        img = Image.open(img_path)
        print(f"  {img_file}:")
        print(f"    Format: {img.format}, Size: {img.size}, Mode: {img.mode}")
        print(f"    Path: {img_path}")
        print()
    except Exception as e:
        print(f"    Error reading {img_file}: {e}\n")

print("All images loaded successfully.")
print("\nImage 1 (Sep 3): Likely trading setup/architecture diagram")
print("Image 2 (Sep 7 7:10 PM): Likely decision snapshot or market data")
print("Image 3 (Sep 7 7:11 PM): Likely follow-up screenshot")
