#!/usr/bin/env python3
"""
Directory Tree Generator
Generates a visual tree structure of your project directory
"""

import os
from pathlib import Path
from typing import Set, List


class TreeGenerator:
    # Default configuration embedded in the class
    DEFAULT_CONFIG = {
        'exclude_dirs': [
            'node_modules', '__pycache__', '.git', '.vscode', '.idea',
            'venv', 'env', 'dist', 'build', '.next', 'coverage',
            '.pytest_cache', '.mypy_cache'
        ],
        'exclude_files': [
            '.DS_Store', 'Thumbs.db', '.gitignore', 'package-lock.json',
            'yarn.lock', '.env'
        ],
        'exclude_patterns': ['.pyc', '.pyo', '.log'],
        'include_extensions': None,  # None = include all, or list like ['.py', '.js']
        'max_depth': None  # None = unlimited
    }

    def __init__(self, config: dict = None):
        """Initialize with configuration"""
        self.config = {**self.DEFAULT_CONFIG, **(config or {})}
        self.exclude_dirs = set(self.config['exclude_dirs'])
        self.exclude_files = set(self.config['exclude_files'])
        self.exclude_patterns = self.config['exclude_patterns']
        self.include_extensions = self.config['include_extensions']
        self.max_depth = self.config['max_depth']

    def _should_exclude(self, path: Path) -> bool:
        """Check if path should be excluded"""
        if path.is_dir():
            return path.name in self.exclude_dirs
        else:
            # Check exact filename match
            if path.name in self.exclude_files:
                return True

            # Check pattern match
            for pattern in self.exclude_patterns:
                if path.name.endswith(pattern):
                    return True

            # Check extension filter
            if self.include_extensions:
                return path.suffix not in self.include_extensions

        return False

    def generate_tree(self, directory: str = ".", output_file: str = None) -> str:
        """Generate tree structure for directory"""
        root_path = Path(directory).resolve()

        if not root_path.exists():
            raise ValueError(f"Directory '{directory}' does not exist")

        tree_lines = [f"{root_path.name}/"]
        self._build_tree(root_path, "", tree_lines, depth=0)

        tree_output = "\n".join(tree_lines)

        if output_file:
            with open(output_file, 'w', encoding='utf-8') as f:
                f.write(tree_output)
            print(f"Tree structure saved to '{output_file}'")

        return tree_output

    def _build_tree(self, path: Path, prefix: str, lines: List[str], depth: int):
        """Recursively build tree structure"""
        if self.max_depth and depth >= self.max_depth:
            return

        try:
            contents = sorted(path.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
            contents = [item for item in contents if not self._should_exclude(item)]
        except PermissionError:
            return

        for i, item in enumerate(contents):
            is_last = i == len(contents) - 1

            # Choose the appropriate tree characters
            if is_last:
                current_prefix = "└── "
                next_prefix = "    "
            else:
                current_prefix = "├── "
                next_prefix = "│   "

            # Add directory indicator
            display_name = item.name + "/" if item.is_dir() else item.name
            lines.append(f"{prefix}{current_prefix}{display_name}")

            # Recurse into directories
            if item.is_dir():
                self._build_tree(item, prefix + next_prefix, lines, depth + 1)


def main():
    """Main function to run the tree generator"""
    import argparse

    parser = argparse.ArgumentParser(
        description='Generate directory tree structure',
        epilog='''
Examples:
  python tree_generator.py                    # Current directory
  python tree_generator.py native3            # Specific directory
  python tree_generator.py -o tree.txt        # Save to file
  python tree_generator.py --max-depth 3      # Limit depth
  python tree_generator.py --ext .py .js      # Only Python and JS files
        ''',
        formatter_class=argparse.RawDescriptionHelpFormatter
    )

    parser.add_argument('directory', nargs='?', default='.',
                        help='Directory to generate tree for (default: current directory)')
    parser.add_argument('-o', '--output', help='Output file (default: print to console)')
    parser.add_argument('--max-depth', type=int, help='Maximum depth to traverse')
    parser.add_argument('--ext', nargs='+', help='Include only these extensions (e.g., .py .js)')
    parser.add_argument('--exclude-dirs', nargs='+', help='Additional directories to exclude')
    parser.add_argument('--exclude-files', nargs='+', help='Additional files to exclude')

    args = parser.parse_args()

    # Build custom config from arguments
    config = {}
    if args.max_depth:
        config['max_depth'] = args.max_depth
    if args.ext:
        config['include_extensions'] = args.ext
    if args.exclude_dirs:
        config['exclude_dirs'] = TreeGenerator.DEFAULT_CONFIG['exclude_dirs'] + args.exclude_dirs
    if args.exclude_files:
        config['exclude_files'] = TreeGenerator.DEFAULT_CONFIG['exclude_files'] + args.exclude_files

    generator = TreeGenerator(config=config)
    tree = generator.generate_tree(args.directory, args.output)

    if not args.output:
        print(tree)


if __name__ == "__main__":
    main()