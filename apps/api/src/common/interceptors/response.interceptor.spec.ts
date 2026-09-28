import { of, lastValueFrom } from 'rxjs';
import { ResponseInterceptor } from './response.interceptor';

describe('ResponseInterceptor', () => {
  const handler = { handle: () => of({ data: 'event' }) };

  it('leaves server-sent event messages unwrapped', async () => {
    const context = { switchToHttp: () => ({ getRequest: () => ({ headers: { accept: 'text/event-stream' } }) }) };
    const response = await lastValueFrom(new ResponseInterceptor().intercept(context as never, handler));
    expect(response).toEqual({ data: 'event' });
  });

  it('wraps ordinary API results', async () => {
    const context = { switchToHttp: () => ({ getRequest: () => ({ headers: { accept: 'application/json' } }) }) };
    const response = await lastValueFrom(new ResponseInterceptor().intercept(context as never, handler));
    expect(response).toEqual({ data: { data: 'event' }, message: 'Operation completed successfully' });
  });
});
