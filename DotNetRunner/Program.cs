using System;

namespace DotNetRunner
{
    internal class Program
    {
        private static int Main(string[] args)
        {
            if (args.Length == 0)
            {
                Console.Error.WriteLine("Usage: DotNetRunner.exe <input>");
                return 1;
            }

            string input = args[0];
            Console.WriteLine($"Processed by .NET Framework {Environment.Version}: {input}");
            return 0;
        }
    }
}
