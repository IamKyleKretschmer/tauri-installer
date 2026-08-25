using System;
using System.DirectoryServices.AccountManagement;

namespace DotNetRunner
{
    /// <summary>
    /// Read-only lookup of the K2 service account and administrators group
    /// in Active Directory. Deliberately never creates AD objects, even
    /// when "Create this group in AD if it does not exist" is checked in
    /// the wizard, that's a separate, explicit action against a
    /// customer's real directory, not something a wizard step should do
    /// silently on Next.
    /// </summary>
    internal static class ActiveDirectoryCheck
    {
        /// <summary>
        /// args: [0]=ad-check, [1]=service account (DOMAIN\user or user@domain),
        /// [2]=administrators group name, [3]=create group if missing (true|false).
        /// </summary>
        public static int CheckObjects(string[] args)
        {
            if (args.Length < 4)
            {
                Console.Error.WriteLine("Usage: DotNetRunner.exe ad-check <service-account> <admins-group> <create-if-missing>");
                return 1;
            }

            string serviceAccountArg = args[1];
            string adminsGroupArg = args[2];
            bool createIfMissing = string.Equals(args[3], "true", StringComparison.OrdinalIgnoreCase);

            string serviceAccountIdentity = StripDomainPrefix(serviceAccountArg);
            string adminsGroupIdentity = StripDomainPrefix(adminsGroupArg);

            try
            {
                using (var context = new PrincipalContext(ContextType.Domain))
                {
                    UserPrincipal user = UserPrincipal.FindByIdentity(context, serviceAccountIdentity);
                    GroupPrincipal group = GroupPrincipal.FindByIdentity(context, adminsGroupIdentity);

                    if (user != null)
                    {
                        Console.WriteLine($"Service account '{serviceAccountArg}' found in Active Directory.");
                    }
                    else
                    {
                        Console.Error.WriteLine($"Service account '{serviceAccountArg}' was not found in Active Directory.");
                        return 1;
                    }

                    if (group != null)
                    {
                        Console.WriteLine($"Administrators group '{adminsGroupArg}' found in Active Directory.");
                    }
                    else if (createIfMissing)
                    {
                        Console.WriteLine($"Administrators group '{adminsGroupArg}' was not found. It will need to be created before K2 is installed (this wizard does not create AD objects automatically).");
                    }
                    else
                    {
                        Console.WriteLine($"Administrators group '{adminsGroupArg}' was not found in Active Directory. Create it manually or enable \"Create this group in AD if it does not exist\".");
                    }

                    return 0;
                }
            }
            catch (PrincipalServerDownException ex)
            {
                Console.Error.WriteLine($"Could not reach Active Directory: {ex.Message}");
                return 1;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"Unexpected error checking Active Directory: {ex.Message}");
                return 1;
            }
        }

        private static string StripDomainPrefix(string identity)
        {
            int backslash = identity.IndexOf('\\');
            if (backslash >= 0)
            {
                return identity.Substring(backslash + 1);
            }

            int at = identity.IndexOf('@');
            return at >= 0 ? identity.Substring(0, at) : identity;
        }
    }
}
