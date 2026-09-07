#!/usr/bin/env python3
"""
Hermes Continue Script — Resumes work from persistent project memory.

This script implements the 'continue' command for the my-job-agent project.
It loads project state from .hermes/ and produces a resume report.

Usage:
    python scripts/hermes-continue.py

The script:
1. Detects the project directory
2. Loads .hermes/project.json
3. Loads .hermes/state/current-state.json
4. Loads .hermes/state/todo.json
5. Loads .hermes/state/checkpoints.json
6. Loads latest git commit
7. Produces a resume report
8. Identifies the highest-priority unfinished task
"""

import json
import os
import subprocess
import sys
from datetime import datetime


def run_command(cmd: list) -> tuple:
    """Run a shell command and return (stdout, stderr, exit_code)."""
    result = subprocess.run(cmd, capture_output=True, text=True)
    return result.stdout.strip(), result.stderr.strip(), result.returncode


def get_git_info() -> dict:
    """Get current git state."""
    cwd = os.getcwd()
    
    # Get current branch
    branch, _, _ = run_command(['git', 'rev-parse', '--abbrev-ref', 'HEAD'])
    
    # Get current commit
    commit, _, _ = run_command(['git', 'rev-parse', 'HEAD'])
    
    # Get latest commit message
    msg, _, _ = run_command(['git', 'log', '-1', '--format=%H %s'])
    sha = msg.split()[0] if msg else 'unknown'
    message = ' '.join(msg.split()[1:]) if msg else 'unknown'
    
    return {
        'branch': branch,
        'commit': commit,
        'latest_commit': {
            'sha': sha,
            'message': message
        }
    }


def load_json_file(path: str) -> dict:
    """Load a JSON file, return empty dict if not found."""
    try:
        with open(path, 'r') as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def load_project_json() -> dict:
    """Load .hermes/project.json."""
    return load_json_file('.hermes/project.json')


def load_state() -> dict:
    """Load .hermes/state/current-state.json."""
    return load_json_file('.hermes/state/current-state.json')


def load_todo() -> dict:
    """Load .hermes/state/todo.json."""
    return load_json_file('.hermes/state/todo.json')


def load_checkpoints() -> dict:
    """Load .hermes/state/checkpoints.json."""
    return load_json_file('.hermes/state/checkpoints.json')


def get_latest_checkpoint(checkpoints: dict) -> dict:
    """Get the most recent checkpoint."""
    if not checkpoints.get('checkpoints'):
        return None
    return checkpoints['checkpoints'][0]  # Sorted by date descending


def get_highest_priority_todo(todo: dict) -> dict:
    """Get the highest-priority unfinished task."""
    items = todo.get('items', [])
    unfinished = [item for item in items if item['status'] in ('pending', 'in_progress')]
    if not unfinished:
        return None
    # Sort by priority (lower = higher priority) then by status (in_progress first)
    unfinished.sort(key=lambda x: (x['priority'], 0 if x['status'] == 'in_progress' else 1))
    return unfinished[0]


def main():
    """Main entry point."""
    cwd = os.getcwd()
    
    # Ensure we're in the project directory
    if not os.path.exists('.hermes/project.json'):
        print("ERROR: .hermes/project.json not found. This does not appear to be a hermes-enabled project.")
        sys.exit(1)
    
    # Load all state
    project = load_project_json()
    state = load_state()
    todo = load_todo()
    checkpoints = load_checkpoints()
    git = get_git_info()
    latest_checkpoint = get_latest_checkpoint(checkpoints)
    highest_priority_todo = get_highest_priority_todo(todo)
    
    # Build resume report
    print("HERMES RESUME")
    print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    
    # Model info (from environment or default)
    model = os.environ.get('HERMES_MODEL', 'Qwen3 Coder Next')
    print(f"Model: {model}")
    
    # Project info
    print(f"Project: {project.get('name', 'unknown')}")
    print(f"Branch: {git['branch']}")
    print(f"Current commit: {git['commit']}")
    print(f"Latest checkpoint: {latest_checkpoint['sha'][:7] if latest_checkpoint else 'none'} — {latest_checkpoint['message'][:40] if latest_checkpoint else 'none'}")
    
    # Current objective
    print(f"\nCurrent objective: {state.get('current_objective', 'Unknown')}")
    print(f"Current workstream: {state.get('current_workstream', 'Unknown')}")
    
    # Completed
    completed = state.get('completed', [])
    if completed:
        print("\nCompleted:")
        for item in completed:
            print(f"  ✓ {item}")
    else:
        print("\nCompleted: (none)")
    
    # In progress
    in_progress = state.get('in_progress', [])
    if in_progress:
        print("\nIn progress:")
        for item in in_progress:
            print(f"  → {item}")
    else:
        print("\nIn progress: (none)")
    
    # Blocked
    blocked = state.get('blocked', [])
    if blocked:
        print("\nBlocked:")
        for item in blocked:
            print(f"  ✗ {item}")
    else:
        print("\nBlocked: (none)")
    
    # Known issues
    issues = load_json_file('.hermes/memory/known-issues.md')
    known_issues = state.get('known_issues', [])
    if known_issues:
        print("\nKnown issues:")
        for item in known_issues:
            print(f"  • {item}")
    
    # Last verified
    last_verified = state.get('last_verified', {})
    if last_verified:
        print("\nLast verified:")
        for key, value in last_verified.items():
            print(f"  ✓ {key}: {value}")
    
    # Next action
    print("\nNext action:")
    if highest_priority_todo:
        print(f"  • Continue: {highest_priority_todo['description'][:80]}")
        print(f"    Priority: {highest_priority_todo['priority']} | Status: {highest_priority_todo['status']}")
    else:
        print("  • No pending tasks — review completed work or start new task")
    
    print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    
    # Check for divergence between memory and repository
    if latest_checkpoint:
        checkpoint_sha = latest_checkpoint.get('sha', '')[:7]
        current_sha = git['commit'][:7]
        if checkpoint_sha != current_sha:
            print(f"\nWARNING: Memory checkpoint ({checkpoint_sha}) differs from current commit ({current_sha})")
            print("Consider running 'hermes project sync' to update memory from repository.")
    
    print()
    
    return 0


if __name__ == '__main__':
    sys.exit(main())
