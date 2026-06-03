import * as parser from '@babel/parser';
import traverse from '@babel/traverse';
import generate from '@babel/generator';
import * as t from '@babel/types';
import type { AgentMode } from './SmartCrusher';

export class CodeCompressor {
  static skeletonize(code: string, mode: AgentMode): string {
    try {
      const ast = parser.parse(code, {
        sourceType: 'unambiguous',
        plugins: ['typescript', 'jsx'],
      });

      traverse(ast, {
        Function(funcPath) {
          if (funcPath.node.body.type !== 'BlockStatement') return;
          const omitted = t.emptyStatement();
          omitted.trailingComments = [{ type: 'CommentBlock', value: ' omitted ' }];
          funcPath.node.body = t.blockStatement([omitted]);
        },
        enter(anyPath) {
          if (mode === 'coding' && anyPath.node.leadingComments) {
            anyPath.node.leadingComments = undefined;
          }
        },
      });

      return generate(ast, { comments: mode === 'thinking' }).code;
    } catch {
      return code;
    }
  }
}
