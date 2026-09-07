#!/usr/bin/env python3
"""
Hermes Checkpoint Script — Creates and manages project checkpoints.

Usage:
    python scripts/hermes-checkpoint.py create <message> [status]
    python scripts/hermes-checkpoint.py list
    python scripts/hermes-checkpoint.py show <sha>
    python scripts/hermes-checkpoint.py sync

Commands:
    create <message> [status] — Create a new checkpoint
        status: VERIFIED | IMPLEMENTED-BUT-UNVERIFIED | BLOCKED | UNFINALISED | FAILED (default: UNFINALISED)
    
    list — List all checkpoints
    
    show <sha> — Show details of a specific checkpoint
    
    sync — Sync memory from current repository state

Examples:
    python scripts/hermes-checkpoint.py create "P0 verification complete" VERIFIED
    python scripts/hermes-checkpoint.py create "feature-x implementation" UNFINALISED
    python scripts/hermes-checkpoint.py list
    python scripts/hermes-checkpoint.py show abc1234
    python scripts/hermes-checkpoint.py sync
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


def load_json_file(path: str) -> dict:
    """Load a JSON file, return empty dict if not found."""
    try:
        with open(path, 'r') as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_json_file(path: str, data: dict) -> None:
    """Save data to a JSON file with pretty formatting."""
    with open(path, 'w') as f:
        json.dump(data, f, indent=2)


def get_git_info() -> dict:
    """Get current git state."""
    # Get current commit
    commit, _, _ = run_command(['git', 'rev-parse', 'HEAD'])
    
    # Get latest commit message
    msg, _, _ = run_command(['git', 'log', '-1', '--format=%H %s'])
    sha = msg.split()[0] if msg else 'unknown'
    message = ' '.join(msg.split()[1:]) if msg else 'unknown'
    
    return {
        'commit': commit,
        'sha': sha,
        'message': message
    }


def load_state() -> dict:
    """Load .hermes/state/current-state.json."""
    return load_json_file('.hermes/state/current-state.json')


def load_todo() -> dict:
    """Load .hermes/state/todo.json."""
    return load_json_file('.hermes/state/todo.json')


def load_checkpoints() -> dict:
    """Load .hermes/state/checkpoints.json."""
    return load_json_file('.hermes/state/checkpoints.json')


def get_completed_items(todo: dict) -> list:
    """Extract completed items from todo list."""
    return [item['id'] for item in todo.get('items', []) if item['status'] == 'completed']


def get_in_progress_items(todo: dict) -> list:
    """Extract in-progress items from todo list."""
    return [item['id'] for item in todo.get('items', []) if item['status'] == 'in_progress']


def get_blocked_items(todo: dict) -> list:
    """Extract blocked items from todo list."""
    return [item['id'] for item in todo.get('items', []) if item['status'] == 'blocked']


def create_checkpoint(message: str, status: str = 'UNFINALISED') -> None:
    """Create a new checkpoint."""
    git = get_git_info()
    state = load_state()
    todo = load_todo()
    checkpoints = load_checkpoints()
    
    checkpoint = {
        'sha': git['sha'],
        'message': message,
        'date': datetime.utcnow().isoformat() + 'Z',
        'status': status.upper(),
        'completed': get_completed_items(todo),
        'in_progress': get_in_progress_items(todo),
        'blocked': get_blocked_items(todo),
        'build_status': state.get('last_verified', {}).get('build', 'unknown'),
        'test_status': state.get('last_verified', {}).get('tests', 'unknown'),
        'notes': state.get('notes', '')
    }
    
    # Insert at beginning (most recent first)
    if 'checkpoints' not in checkpoints:
        checkpoints['checkpoints'] = []
    checkpoints['checkpoints'].insert(0, checkpoint)
    checkpoints['last_updated'] = datetime.utcnow().isoformat() + 'Z'
    
    save_json_file('.hermes/state/checkpoints.json', checkpoints)
    
    print(f"Checkpoint created: {git['sha'][:7]} — {message}")
    print(f"Status: {status.upper()}")
    print()
    print("Completed:")
    for item in checkpoint['completed']:
        print(f"  ✓ {item}")
    print()
    print("In Progress:")
    for item in checkpoint['in_progress']:
        print(f"  → {item}")
    print()
    print("Notes:")
    print(f"  Build: {checkpoint['build_status']}")
    print(f"  Tests: {checkpoint['test_status']}")


def list_checkpoints() -> None:
    """List all checkpoints."""
    checkpoints = load_checkpoints()
    items = checkpoints.get('checkpoints', [])
    
    print("CHECKPOINTS")
    print("=" * 80)
    
    for i, item in enumerate(items, 1):
        sha_short = item.get('sha', '')[:7]
        message = item.get('message', '')[:50]
        date = item.get('date', '')[:10]
        status = item.get('status', 'UNKNOWN')
        print(f"{i:2}. [{status:12}] {sha_short} {message} ({date})")


def show_checkpoint(sha: str) -> None:
    """Show details of a specific checkpoint."""
    checkpoints = load_checkpoints()
    items = checkpoints.get('checkpoints', [])
    
    # Find checkpoint by SHA
    target = None
    for item in items:
        if item.get('sha', '').startswith(sha):
            target = item
            break
    
    if not target:
        print(f"Checkpoint not found: {sha}")
        return
    
    print(f"CHECKPOINT: {target.get('sha', 'unknown')}")
    print("=" * 60)
    print(f"Message: {target.get('message', 'unknown')}")
    print(f"Date: {target.get('date', 'unknown')}")
    print(f"Status: {target.get('status', 'unknown')}")
    print()
    print("Completed:")
    for item in target.get('completed', []):
        print(f"  ✓ {item}")
    print()
    print("In Progress:")
    for item in target.get('in_progress', []):
        print(f"  → {item}")
    print()
    print("Blocked:")
    for item in target.get('blocked', []):
        print(f"  ✗ {item}")
    print()
    print(f"Build: {target.get('build_status', 'unknown')}")
    print(f"Tests: {target.get('test_status', 'unknown')}")
    print()
    if target.get('notes'):
        print("Notes:")
        print(f"  {target['notes']}")


def sync_checkpoint() -> None:
    """Sync memory from current repository state."""
    git = get_git_info()
    state = load_state()
    todo = load_todo()
    checkpoints = load_checkpoints()
    
    # Update project.json
    project = load_json_file('.hermes/project.json')
    project['current_checkpoint'] = {
        'sha': git['sha'],
        'message': git['message'],
        'status': 'SYNCED',
        'completed': get_completed_items(todo),
        'in_progress': get_in_progress_items(todo),
        'blocked': get_blocked_items(todo),
        'build_status': state.get('last_verified', {}).get('build', 'unknown'),
        'test_status': state.get('last_verified', {}).get('tests', 'unknown')
    }
    save_json_file('.hermes/project.json', project)
    
    # Update checkpoints.json
    checkpoint = {
        'sha': git['sha'],
        'message': git['message'],
        'date': datetime.utcnow().isoformat() + 'Z',
        'status': 'SYNCED',
        'completed': get_completed_items(todo),
        'in_progress': get_in_progress_items(todo),
        'blocked': get_blocked_items(todo),
        'build_status': state.get('last_verified', {}).get('build', 'unknown'),
        'test_status': state.get('last_verified', {}).get('tests', 'unknown'),
        'notes': 'Synced from repository state'
    }
    checkpoints['checkpoints'].insert(0, checkpoint)
    checkpoints['last_updated'] = datetime.utcnow().isoformat() + 'Z'
    save_json_file('.hermes/state/checkpoints.json', checkpoints)
    
    print(f"Memory synced to repository: {git['sha'][:7]} — {git['message']}")


def main():
    """Main entry point."""
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    
    command = sys.argv[1].lower()
    
    if command == 'create':
        if len(sys.argv) < 3:
            print("ERROR: 'create' requires a message argument")
            print(__doc__)
            return 1
        message = sys.argv[2]
        status = sys.argv[3].upper() if len(sys.argv) > 3 else 'UNFINALISED'
        # Validate status
        valid_statuses = ['VERIFIED', 'IMPLEMENTED-BUT-UNVERIFIED', 'BLOCKED', 'UNFINALISED', 'FAILED']
        if status not in valid_statuses:
            print(f"ERROR: Invalid status. Must be one of: {', '.join(valid_statuses)}")
            return 1
        create_checkpoint(message, status)
    
    elif command == 'list':
        list_checkpoints()
    
    elif command == 'show':
        if len(sys.argv) < 3:
            print("ERROR: 'show' requires a SHA argument")
            print(__doc__)
            return 1
        show_checkpoint(sys.argv[2])
    
    elif command == 'sync':
        sync_checkpoint()
    
    else:
        print(f"Unknown command: {command}")
        print(__doc__)
        return 1
    
    return 0


if __name__ == '__main__':
    sys.exit(main())
