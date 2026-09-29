import { UserRole } from '../../users/entities/user.entity';

export interface JwtUser {
  sub: string;
  email: string;
  username: string;
  role: UserRole;
  type?: 'access' | 'refresh';
  deviceId?: string;
}
