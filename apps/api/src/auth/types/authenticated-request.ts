import { Request } from 'express';
import { JwtUser } from './jwt-user';

export type AuthenticatedRequest = Request & { user: JwtUser };
