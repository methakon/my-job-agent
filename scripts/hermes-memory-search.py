#!/usr/bin/env python3
"""
Hermes Memory Search Script — Retrieves persistent project memory.

Usage:
    python scripts/hermes-memory-search.py <query>

Supported queries:
    - "architecture" — Show architecture decisions
    - "safety" — Show safety rules
    - "skills" — Show skills registry
    - "work-history" — Show work history
    - "session-history" — Show session history
    - "todo" — Show current todo list
    - "checkpoint" — Show latest checkpoint
    - "issue <pattern>" — Search known issues

Examples:
    python scripts/hermes-memory-search.py architecture
    python scripts/hermes-memory-search.py safety
    python scripts/hermes-memory-search.py todo
    python scripts/hermes-memory-search.py issue P0
"""

import json
import os
import sys


def load_json_file(path: str) -> dict:
    """Load a JSON file, return empty dict if not found."""
    try:
        with open(path, 'r') as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def load_file(path: str) -> str:
    """Load a text file, return empty string if not found."""
    try:
        with open(path, 'r') as f:
            return f.read()
    except FileNotFoundError:
        return ''


def search_content(content: str, query: str) -> list:
    """Search for query in content, return matching lines."""
    lines = content.split('\n')
    hits = []
    for line in lines:
        if query.lower() in line.lower():
            hits.append(line.strip())
    return hits


def show_architecture():
    """Show architecture decisions."""
    content = load_file('.hermes/memory/architecture.md')
    print(content)


def show_safety():
    """Show safety rules."""
    content = load_file('.hermes/memory/safety.md')
    print(content)


def show_skills():
    """Show skills registry."""
    content = load_file('.hermes/memory/skills.md')
    print(content)


def show_work_history():
    """Show work history."""
    content = load_file('.hermes/memory/work-history.md')
    print(content)


def show_session_history():
    """Show session history."""
    content = load_file('.hermes/memory/session-history.md')
    print(content)


def show_todo():
    """Show current todo list."""
    todo = load_json_file('.hermes/state/todo.json')
    items = todo.get('items', [])
    
    print("TODO LIST")
    print("=" * 60)
    
    for item in sorted(items, key=lambda x: (x['priority'], x['id'])):
        status = item['status'].upper().ljust(12)
        priority = f"P{item['priority']}".ljust(5)
        print(f"[{status}] [{priority}] {item['id']}: {item['description'][:70]}")
    
    print("=" * 60)
    print(f"Total: {len(items)} items")
    pending = len([i for i in items if i['status'] == 'pending'])
    in_progress = len([i for i in items if i['status'] == 'in_progress'])
    completed = len([i for i in items if i['status'] == 'completed'])
    print(f"Pending: {pending} | In Progress: {in_progress} | Completed: {completed}")


def show_checkpoint():
    """Show latest checkpoint."""
    checkpoints = load_json_file('.hermes/state/checkpoints.json')
    c = checkpoints.get('checkpoints', [{}])[0]
    
    if not c:
        print("No checkpoints found.")
        return
    
    print("LATEST CHECKPOINT")
    print("=" * 60)
    print(f"SHA: {c.get('sha', 'unknown')}")
    print(f"Message: {c.get('message', 'unknown')}")
    print(f"Date: {c.get('date', 'unknown')}")
    print(f"Status: {c.get('status', 'unknown')}")
    print()
    print("Completed:")
    for item in c.get('completed', []):
        print(f"  ✓ {item}")
    print()
    print("In Progress:")
    for item in c.get('in_progress', []):
        print(f"  → {item}")
    print()
    print("Build Status:", c.get('build_status', 'unknown'))
    print("Test Status:", c.get('test_status', 'unknown'))


def search_issues(query: str):
    """Search known issues for query."""
    content = load_file('.hermes/memory/known-issues.md')
    hits = search_content(content, query)
    
    if not hits:
        print(f"No issues matching '{query}' found.")
        return
    
    print(f"ISSUES MATCHING '{query}'")
    print("=" * 60)
    for hit in hits:
        print(f"• {hit}")
    print("=" * 60)


def main():
    """Main entry point."""
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    
    query = sys.argv[1].lower()
    
    if query == 'architecture':
        show_architecture()
    elif query == 'safety':
        show_safety()
    elif query == 'skills':
        show_skills()
    elif query == 'work-history' or query == 'workhistory':
        show_work_history()
    elif query == 'session-history' or query == 'sessionhistory':
        show_session_history()
    elif query == 'todo':
        show_todo()
    elif query == 'checkpoint':
        show_checkpoint()
    elif query.startswith('issue'):
        # Extract pattern after "issue "
        pattern = ' '.join(sys.argv[2:]) if len(sys.argv) > 2 else ''
        search_issues(pattern)
    else:
        print(f"Unknown query: {query}")
        print("Available queries: architecture, safety, skills, work-history, session-history, todo, checkpoint, issue <pattern>")
        return 1
    
    return 0


if __name__ == '__main__':
    sys.exit(main())
