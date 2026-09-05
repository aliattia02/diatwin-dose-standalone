#!/usr/bin/env python3
"""
Folder & File Structure Generator
Reads a tree structure from a text file and creates folders and files
"""

import os
import re
from pathlib import Path


class StructureGenerator:
    def __init__(self, structure_file: str, root_dir: str = None):
        """
        Initialize the structure generator

        Args:
            structure_file: Path to the structure.txt file
            root_dir: Root directory where structure will be created (default: current directory)
        """
        self.structure_file = structure_file
        self.root_dir = Path(root_dir) if root_dir else Path.cwd()
        self.tree_lines = []

    def read_structure(self):
        """Read and parse the structure file"""
        with open(self.structure_file, 'r', encoding='utf-8') as f:
            self.tree_lines = [line.rstrip() for line in f.readlines()]

        if not self.tree_lines:
            raise ValueError("Structure file is empty!")

        return self.tree_lines

    def parse_tree_line(self, line: str):
        """
        Parse a single line from the tree structure

        Returns:
            (depth, name, is_dir) tuple
        """
        # Remove tree characters and count depth
        clean_line = line
        depth = 0

        # Count indentation (each level is 4 spaces or one tree character)
        # Tree characters: │   ├── └── 

        # Remove leading tree characters
        tree_chars = ['│   ', '├── ', '└── ', '    ']
        while any(clean_line.startswith(char) for char in tree_chars):
            for char in tree_chars:
                if clean_line.startswith(char):
                    clean_line = clean_line[len(char):]
                    depth += 1
                    break

        # Check if it's a directory (ends with /)
        is_dir = clean_line.endswith('/')
        name = clean_line.rstrip('/')

        return depth, name, is_dir

    def generate_structure(self, create_placeholder_content: bool = True):
        """
        Generate the folder and file structure

        Args:
            create_placeholder_content: If True, creates HTML files with basic content
        """
        self.read_structure()

        # Skip the first line (root directory name)
        if self.tree_lines:
            root_name = self.tree_lines[0].rstrip('/')
            print(f"📁 Creating structure for: {root_name}")

            # Create root directory
            project_root = self.root_dir / root_name
            project_root.mkdir(exist_ok=True)

            # Track current path at each depth level
            path_stack = {0: project_root}
            current_depth = 0

            # Process each line
            for line in self.tree_lines[1:]:
                if not line.strip():
                    continue

                depth, name, is_dir = self.parse_tree_line(line)

                # Get parent directory
                parent_path = path_stack.get(depth - 1, project_root)
                current_path = parent_path / name

                if is_dir:
                    # Create directory
                    current_path.mkdir(exist_ok=True)
                    path_stack[depth] = current_path
                    print(f"{'  ' * depth}📁 Created folder: {current_path.relative_to(self.root_dir)}")
                else:
                    # Create file
                    current_path.parent.mkdir(parents=True, exist_ok=True)

                    if not current_path.exists():
                        # Create file with placeholder content
                        if create_placeholder_content and current_path.suffix == '.html':
                            self._create_html_file(current_path, name)
                        else:
                            current_path.touch()

                        print(f"{'  ' * depth}📄 Created file: {current_path.relative_to(self.root_dir)}")
                    else:
                        print(f"{'  ' * depth}⏭️  Skipped (exists): {current_path.relative_to(self.root_dir)}")

            print(f"\n✅ Structure created successfully in: {project_root}")
            return project_root

    def _create_html_file(self, filepath: Path, filename: str):
        """Create an HTML file with basic template"""
        # Clean filename for title
        title = filename.replace('.html', '').replace('-', ' ').title()

        html_content = f'''<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{title}</title>
</head>
<body>
    <h1>{title}</h1>
    <p>Content coming soon...</p>
    <a href="../index.html">← Back to Home</a>
</body>
</html>
'''

        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(html_content)


def main():
    """Main function with command line interface"""
    import argparse

    parser = argparse.ArgumentParser(
        description='Generate folder and file structure from tree file',
        epilog='''
Examples:
  python create_structure.py structure.txt
  python create_structure.py structure.txt -o my-project
  python create_structure.py structure.txt --no-content
        ''',
        formatter_class=argparse.RawDescriptionHelpFormatter
    )

    parser.add_argument('structure_file', help='Path to structure.txt file')
    parser.add_argument('-o', '--output', help='Output directory (default: current directory)')
    parser.add_argument('--no-content', action='store_true',
                        help='Create empty files without placeholder content')

    args = parser.parse_args()

    # Validate structure file exists
    if not os.path.exists(args.structure_file):
        print(f"❌ Error: File '{args.structure_file}' not found!")
        return 1

    # Create generator
    generator = StructureGenerator(
        structure_file=args.structure_file,
        root_dir=args.output
    )

    # Generate structure
    try:
        generator.generate_structure(create_placeholder_content=not args.no_content)
        print("\n🎉 Done!")
        return 0
    except Exception as e:
        print(f"\n❌ Error: {e}")
        import traceback
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    exit(main())