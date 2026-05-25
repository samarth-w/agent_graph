/**
 * Framework Route Extraction Tests
 */
import { describe, it, expect } from 'vitest';
import { extractRoutes } from '../src/frameworks';

describe('Express/Koa/Hono Routes', () => {
  it('extracts app.get route', () => {
    const code = `app.get('/users', listUsers);`;
    const routes = extractRoutes(code, 'routes.ts', 'typescript');
    expect(routes.length).toBeGreaterThanOrEqual(1);
    const r = routes.find(r => r.pattern === '/users');
    expect(r).toBeDefined();
    expect(r!.method).toBe('GET');
    expect(r!.handler).toBe('listUsers');
  });

  it('extracts app.post route', () => {
    const code = `app.post('/users', createUser);`;
    const routes = extractRoutes(code, 'routes.ts', 'typescript');
    const r = routes.find(r => r.pattern === '/users');
    expect(r).toBeDefined();
    expect(r!.method).toBe('POST');
  });

  it('extracts app.put route', () => {
    const code = `app.put('/users/:id', updateUser);`;
    const routes = extractRoutes(code, 'routes.ts', 'typescript');
    const r = routes.find(r => r.pattern === '/users/:id');
    expect(r).toBeDefined();
    expect(r!.method).toBe('PUT');
  });

  it('extracts app.delete route', () => {
    const code = `app.delete('/users/:id', deleteUser);`;
    const routes = extractRoutes(code, 'routes.ts', 'typescript');
    const r = routes.find(r => r.pattern === '/users/:id');
    expect(r).toBeDefined();
    expect(r!.method).toBe('DELETE');
  });

  it('extracts multiple routes', () => {
    const code = `
app.get('/users', listUsers);
app.post('/users', createUser);
app.get('/users/:id', getUser);
`;
    const routes = extractRoutes(code, 'routes.ts', 'typescript');
    expect(routes.length).toBe(3);
  });

  it('extracts router.get with arrow function handler', () => {
    const code = `router.get('/items', (req, res) => { res.json([]); });`;
    const routes = extractRoutes(code, 'routes.ts', 'typescript');
    expect(routes.length).toBeGreaterThanOrEqual(1);
  });
});

describe('React Router Routes', () => {
  it('extracts <Route path component>', () => {
    const code = `<Route path="/users" component={UsersPage} />`;
    const routes = extractRoutes(code, 'App.tsx', 'tsx');
    const r = routes.find(r => r.pattern === '/users');
    expect(r).toBeDefined();
    expect(r!.handler).toBe('UsersPage');
  });

  it('extracts <Route path element>', () => {
    const code = `<Route path="/login" element={<LoginPage/>} />`;
    const routes = extractRoutes(code, 'App.tsx', 'tsx');
    const r = routes.find(r => r.pattern === '/login');
    expect(r).toBeDefined();
  });
});

describe('Next.js File-based Routes', () => {
  it('extracts route from pages directory', () => {
    const code = `export default function About() { return <div>About</div>; }`;
    const routes = extractRoutes(code, 'pages/about.tsx', 'tsx');
    const r = routes.find(r => r.pattern.includes('/about'));
    expect(r).toBeDefined();
  });

  it('extracts route from app directory', () => {
    const code = `export default function Page() { return <div>Dashboard</div>; }`;
    const routes = extractRoutes(code, 'app/dashboard/page.tsx', 'tsx');
    const r = routes.find(r => r.pattern.includes('/dashboard'));
    expect(r).toBeDefined();
  });

  it('converts [param] to :param', () => {
    const code = `export default function UserPage() { return <div>User</div>; }`;
    const routes = extractRoutes(code, 'pages/users/[id].tsx', 'tsx');
    const r = routes.find(r => r.pattern.includes(':id'));
    expect(r).toBeDefined();
  });
});

describe('Flask Routes', () => {
  it('extracts @app.route', () => {
    const code = `@app.route('/users')
def list_users():
    return []`;
    const routes = extractRoutes(code, 'app.py', 'python');
    const r = routes.find(r => r.pattern === '/users');
    expect(r).toBeDefined();
    expect(r!.handler).toBe('list_users');
  });
});

describe('FastAPI Routes', () => {
  it('extracts @app.get', () => {
    const code = `@app.get('/users')
async def list_users():
    return []`;
    const routes = extractRoutes(code, 'main.py', 'python');
    const r = routes.find(r => r.pattern === '/users');
    expect(r).toBeDefined();
    expect(r!.method).toBe('GET');
  });

  it('extracts @router.post', () => {
    const code = `@router.post('/items')
def create_item(item: Item):
    pass`;
    const routes = extractRoutes(code, 'items.py', 'python');
    const r = routes.find(r => r.pattern === '/items');
    expect(r).toBeDefined();
    expect(r!.method).toBe('POST');
  });
});

describe('Django Routes', () => {
  it('extracts path()', () => {
    const code = `urlpatterns = [
    path('users/', UserListView.as_view(), name='user-list'),
]`;
    const routes = extractRoutes(code, 'urls.py', 'python');
    expect(routes.length).toBeGreaterThanOrEqual(1);
  });
});

describe('No Routes', () => {
  it('returns empty for plain code', () => {
    const code = `function add(a: number, b: number) { return a + b; }`;
    const routes = extractRoutes(code, 'utils.ts', 'typescript');
    expect(routes).toEqual([]);
  });
});
