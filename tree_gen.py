#!/usr/bin/env python3
"""
Directory Tree Generator
Generates a visual tree structure of your project directory
"""

import os
import fnmatch
from pathlib import Path
from typing import Set, List, Optional


class TreeGenerator:
    # Default configuration embedded in the class
    DEFAULT_CONFIG = {
        'exclude_dirs': [
            # Python / general
            'node_modules', '__pycache__', '.git', '.vscode', '.idea',
            'venv', 'env', 'dist', 'build', '.next', 'coverage',
            '.pytest_cache', '.mypy_cache',
            # Expo / React Native
            '.expo', '.expo-shared',
            # Android build cache
            '.gradle', '.kotlin',
            # Gradle internal sub-dirs (inside .gradle)
            'checksums', 'executionHistory', 'expanded', 'fileChanges',
            'fileHashes', 'vcsMetadata', 'vcs-1', 'noVersion',
            'buildOutputCleanup', 'sessions',
            # Gradle wrapper folder (contains only .jar / .properties)
            'wrapper',
        ],
        # Glob patterns matched against directory *names* (supports * and ?)
        'exclude_dir_patterns': [
            'mipmap-*',      # mipmap-hdpi, mipmap-mdpi, mipmap-xxhdpi …
            'drawable-*',    # drawable-hdpi, drawable-night …
            'values-*',      # values-night, values-v21 …
            'debug*',        # debugOptimized, debug (android src variant)
            '*.gradle',      # any stray *.gradle directory
        ],
        'exclude_files': [
            # OS / editor noise
            '.DS_Store', 'Thumbs.db', '.gitignore',
            'package-lock.json', 'yarn.lock', '.env',
            # Windows shortcuts
            'src - Shortcut.lnk', 'components - Shortcut.lnk',
            'utils - Shortcut.lnk', 'native3 - Shortcut.lnk',
            # Android signing / build
            'debug.keystore', 'gradlew', 'gradlew.bat',
            'gradle-wrapper.jar', 'gradle-wrapper.properties',
            # Gradle state files
            'gc.properties', 'last-build.bin', 'file-system.probe',
            'buildLogic.lock',
        ],
        'exclude_patterns': [
            # Compiled / cache
            '.pyc', '.pyo', '.log',
            # Binary / lock artefacts
            '.bin', '.lock', '.probe', '.jar',
            # Signing / credentials
            '.keystore', '.jks',
            # Windows shortcuts
            '.lnk',
            # Image assets (keep .svg; exclude raster bundles)
            '.webp',
        ],
        'include_extensions': None,  # None = include all, or list like ['.py', '.js']
        'max_depth': None            # None = unlimited
    }

    def __init__(self, config: dict = None):
        """Initialize with configuration"""
        self.config = {**self.DEFAULT_CONFIG, **(config or {})}
        self.exclude_dirs = set(self.config['exclude_dirs'])
        self.exclude_dir_patterns: List[str] = self.config.get('exclude_dir_patterns', [])
        self.exclude_files = set(self.config['exclude_files'])
        self.exclude_patterns: List[str] = self.config['exclude_patterns']
        self.include_extensions = self.config['include_extensions']
        self.max_depth = self.config['max_depth']

    def _dir_is_excluded(self, path: Path) -> bool:
        """Check whether a *directory* should be excluded."""
        name = path.name
        if name in self.exclude_dirs:
            return True
        for pattern in self.exclude_dir_patterns:
            if fnmatch.fnmatch(name, pattern):
                return True
        return False

    def _file_is_excluded(self, path: Path) -> bool:
        """Check whether a *file* should be excluded."""
        name = path.name
        if name in self.exclude_files:
            return True
        for pattern in self.exclude_patterns:
            if name.endswith(pattern):
                return True
        if self.include_extensions:
            return path.suffix not in self.include_extensions
        return False

    def _should_exclude(self, path: Path) -> bool:
        """Unified exclusion check."""
        return self._dir_is_excluded(path) if path.is_dir() else self._file_is_excluded(path)

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
        if self.max_depth is not None and depth >= self.max_depth:
            return

        try:
            contents = sorted(
                path.iterdir(),
                key=lambda p: (not p.is_dir(), p.name.lower())
            )
            contents = [item for item in contents if not self._should_exclude(item)]
        except PermissionError:
            return

        for i, item in enumerate(contents):
            is_last = i == len(contents) - 1

            current_prefix = "└── " if is_last else "├── "
            next_prefix    = "    " if is_last else "│   "

            display_name = item.name + "/" if item.is_dir() else item.name
            lines.append(f"{prefix}{current_prefix}{display_name}")

            if item.is_dir():
                self._build_tree(item, prefix + next_prefix, lines, depth + 1)


def main():
    """Main function to run the tree generator"""
    import argparse

    parser = argparse.ArgumentParser(
        description='Generate directory tree structure',
        epilog='''
Examples:
  python tree_gen.py                        # Current directory
  python tree_gen.py native3                # Specific directory
  python tree_gen.py -o tree.txt            # Save to file
  python tree_gen.py --max-depth 3          # Limit depth
  python tree_gen.py --ext .py .js .ts      # Only these extensions
  python tree_gen.py --exclude-dirs .cache  # Extra dirs to skip
        ''',
        formatter_class=argparse.RawDescriptionHelpFormatter
    )

    parser.add_argument('directory', nargs='?', default='.',
                        help='Directory to generate tree for (default: current directory)')
    parser.add_argument('-o', '--output',
                        help='Output file (default: print to console)')
    parser.add_argument('--max-depth', type=int,
                        help='Maximum depth to traverse')
    parser.add_argument('--ext', nargs='+',
                        help='Include only these extensions (e.g. .py .ts)')
    parser.add_argument('--exclude-dirs', nargs='+',
                        help='Additional directory names to exclude')
    parser.add_argument('--exclude-dir-patterns', nargs='+',
                        help='Additional glob patterns for directory names (e.g. "mipmap-*")')
    parser.add_argument('--exclude-files', nargs='+',
                        help='Additional exact filenames to exclude')
    parser.add_argument('--exclude-patterns', nargs='+',
                        help='Additional file suffix patterns to exclude (e.g. .min.js)')

    args = parser.parse_args()

    config: dict = {}

    if args.max_depth:
        config['max_depth'] = args.max_depth
    if args.ext:
        config['include_extensions'] = args.ext
    if args.exclude_dirs:
        config['exclude_dirs'] = (
            TreeGenerator.DEFAULT_CONFIG['exclude_dirs'] + args.exclude_dirs
        )
    if args.exclude_dir_patterns:
        config['exclude_dir_patterns'] = (
            TreeGenerator.DEFAULT_CONFIG['exclude_dir_patterns'] + args.exclude_dir_patterns
        )
    if args.exclude_files:
        config['exclude_files'] = (
            TreeGenerator.DEFAULT_CONFIG['exclude_files'] + args.exclude_files
        )
    if args.exclude_patterns:
        config['exclude_patterns'] = (
            TreeGenerator.DEFAULT_CONFIG['exclude_patterns'] + args.exclude_patterns
        )

    generator = TreeGenerator(config=config)
    tree = generator.generate_tree(args.directory, args.output)

    if not args.output:
        print(tree)


if __name__ == "__main__":
    main()