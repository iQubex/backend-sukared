const LUA_KEYWORDS = [
    'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function',
    'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true',
    'until', 'while', 'continue', 'export', 'type'
];

const LUA_GLOBALS = [
    '_G', '_VERSION', 'assert', 'collectgarbage', 'dofile', 'error', 'getfenv',
    'getmetatable', 'ipairs', 'load', 'loadfile', 'loadstring', 'module', 'next',
    'pairs', 'pcall', 'print', 'rawequal', 'rawget', 'rawlen', 'rawset', 'require',
    'select', 'setfenv', 'setmetatable', 'tonumber', 'tostring', 'type', 'unpack',
    'xpcall', 'newproxy'
];

const LUA_LIBRARIES = [
    'bit32', 'buffer', 'coroutine', 'debug', 'math', 'os', 'string', 'table',
    'utf8', 'task'
];

const LUA_LIBRARY_MEMBERS = [
    'abs', 'acos', 'asin', 'atan', 'atan2', 'ceil', 'clamp', 'cos', 'cosh', 'deg',
    'exp', 'floor', 'fmod', 'frexp', 'ldexp', 'log', 'log10', 'max', 'min', 'modf',
    'noise', 'pow', 'rad', 'random', 'randomseed', 'round', 'sign', 'sin', 'sinh',
    'sqrt', 'tan', 'tanh', 'huge', 'pi',
    'byte', 'char', 'dump', 'find', 'format', 'gmatch', 'gsub', 'len', 'lower',
    'match', 'pack', 'packsize', 'rep', 'reverse', 'split', 'sub', 'upper',
    'clear', 'clone', 'concat', 'create', 'find', 'foreach', 'foreachi', 'freeze',
    'getn', 'insert', 'isfrozen', 'maxn', 'move', 'remove', 'sort',
    'close', 'create', 'isyieldable', 'resume', 'running', 'status', 'wrap', 'yield',
    'cancel', 'defer', 'delay', 'desynchronize', 'spawn', 'synchronize', 'wait',
    'clock', 'date', 'difftime', 'time',
    'charpattern', 'codes', 'codepoint', 'graphemes', 'nfdnormalize', 'nfcnormalize',
    'arshift', 'band', 'bnot', 'bor', 'btest', 'bxor', 'countlz', 'countrz',
    'extract', 'lrotate', 'lshift', 'replace', 'rrotate', 'rshift',
    'info', 'traceback', 'profilebegin', 'profileend', 'resetmemorycategory',
    'setmemorycategory'
];

const ROBLOX_GLOBALS = [
    'Axes', 'BrickColor', 'CFrame', 'Color3', 'ColorSequence', 'ColorSequenceKeypoint',
    'DateTime', 'DockWidgetPluginGuiInfo', 'Enum', 'Faces', 'Instance', 'NumberRange',
    'NumberSequence', 'NumberSequenceKeypoint', 'OverlapParams', 'PathWaypoint',
    'PhysicalProperties', 'Random', 'Ray', 'RaycastParams', 'Rect', 'Region3',
    'Region3int16', 'TweenInfo', 'UDim', 'UDim2', 'Vector2', 'Vector2int16',
    'Vector3', 'Vector3int16', 'Vector3int16', 'SharedTable',
    'CatalogSearchParams', 'CellId', 'Color3uint8', 'Content', 'Font',
    'FloatCurveKey', 'RotationCurveKey',
    'DebuggerManager', 'ElapsedTime', 'PluginManager', 'settings', 'Stats',
    'UserSettings', 'Version', 'Wait', 'warn', 'delay', 'elapsedTime',
    'gcinfo', 'plugin', 'script', 'shared', 'spawn', 'tick', 'time', 'typeof',
    'version', 'wait', 'workspace', 'game', 'owner'
];

const ROBLOX_COMMON_MEMBERS = [
    'AbsoluteContentSize', 'AbsolutePosition', 'AbsoluteRotation', 'AbsoluteSize',
    'AccountAge', 'Active', 'Adornee', 'Anchored', 'Archivable', 'AssetId',
    'AutoButtonColor', 'BackgroundColor3', 'BackgroundTransparency', 'BrickColor',
    'CFrame', 'CanCollide', 'CanQuery', 'CanTouch', 'Changed', 'Character',
    'CharacterAdded', 'CharacterRemoving', 'ClassName', 'ClearTextOnFocus',
    'ClickDetector', 'Color', 'Color3', 'Completed', 'CurrentCamera', 'DataCost',
    'DisplayName', 'Enabled', 'FindFirstAncestor', 'FindFirstAncestorOfClass',
    'FindFirstAncestorWhichIsA', 'FindFirstChild', 'FindFirstChildOfClass',
    'FindFirstChildWhichIsA', 'Fire', 'FireAllClients', 'FireClient', 'FireServer',
    'Focused', 'FocusLost', 'Font', 'GetAttribute', 'GetAttributes', 'GetChildren',
    'GetDebugId', 'GetDescendants', 'GetFullName', 'GetMouse', 'GetPropertyChangedSignal',
    'GetService', 'Heartbeat', 'Humanoid', 'IsA', 'IsDescendantOf', 'LocalPlayer',
    'MouseButton1Click', 'MouseButton1Down', 'MouseButton1Up', 'MouseEnter',
    'MouseLeave', 'Name', 'OnClientEvent', 'OnClientInvoke', 'OnServerEvent',
    'OnServerInvoke', 'Parent', 'PivotTo', 'PlayerAdded', 'PlayerGui', 'Players',
    'Position', 'RenderStepped', 'ReplicatedFirst', 'ReplicatedStorage',
    'Require', 'RunService', 'ServerScriptService', 'ServerStorage', 'SetAttribute',
    'Size', 'SoundId', 'StarterGui', 'StarterPack', 'StarterPlayer', 'Stepped',
    'Team', 'Text', 'TextColor3', 'TextLabel', 'TextButton', 'Touched',
    'Transparency', 'UserId', 'Value', 'WaitForChild', 'WalkSpeed', 'X', 'Y', 'Z',
    'new', 'fromRGB', 'fromHSV', 'Angles', 'lookAt', 'identity', 'zero', 'one',
    'Play', 'Stop', 'Pause', 'Destroy', 'Clone', 'Connect', 'Disconnect', 'Once',
    'InvokeServer', 'InvokeClient'
];

const ALL_TERMS = new Set([
    ...LUA_KEYWORDS,
    ...LUA_GLOBALS,
    ...LUA_LIBRARIES,
    ...LUA_LIBRARY_MEMBERS,
    ...ROBLOX_GLOBALS,
    ...ROBLOX_COMMON_MEMBERS
]);

module.exports = {
    LUA_KEYWORDS,
    LUA_GLOBALS,
    LUA_LIBRARIES,
    LUA_LIBRARY_MEMBERS,
    ROBLOX_GLOBALS,
    ROBLOX_COMMON_MEMBERS,
    ALL_TERMS
};
