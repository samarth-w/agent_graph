import * as parser from '@babel/parser';
import traverse from '@babel/traverse';
import generate from '@babel/generator';
import * as t from '@babel/types';

export class CodeCompressor {
  static skeletonize(code: string, mode: 'coding' | 'thinking'): string {
    try {
      const ast = parser.parse(code, {
        sourceType: 'unambiguous',
        plugins: ['typescript', 'jsx'],
      });

      traverse(ast, {
        Function(path) {
          const empty = t.emptyStatement();
          t.addComment(empty, 'trailing', ' body omitted ');
          path.node.body = t.blockStatement([empty]);

          if (path.isArrowFunctionExpression()) {
            path.node.expression = false;
          }
        },
        enter(path) {
          if (mode === 'coding' && path.node.leadingComments) {
            path.node.leadingComments = undefined;
          }
        },
      });

      return generate(ast, { comments: mode === 'thinking' }).code;
    } catch {
      return code;
    }
  }
}
