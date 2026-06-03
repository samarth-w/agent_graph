import * as parser from '@babel/parser';
import traverse from '@babel/traverse';
import generate from '@babel/generator';

export class CodeCompressor {
  static skeletonize(code: string, mode: 'coding' | 'thinking'): string {
    try {
      const ast = parser.parse(code, {
        sourceType: 'unambiguous',
        plugins: ['typescript', 'jsx'],
      });

      traverse(ast, {
        Function(path) {
          (path.node as any).body = {
            type: 'BlockStatement',
            body: [
              {
                type: 'EmptyStatement',
                trailingComments: [{ type: 'CommentBlock', value: ' omitted ' }],
              },
            ],
          };

          if (path.isArrowFunctionExpression()) {
            (path.node as any).expression = false;
          }
        },
        enter(path) {
          if (mode === 'coding' && path.node.leadingComments) {
            path.node.leadingComments = null;
          }
        },
      });

      return generate(ast, { comments: mode === 'thinking' }).code;
    } catch {
      return code;
    }
  }
}
